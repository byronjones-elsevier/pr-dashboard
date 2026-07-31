#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

// ---------------------------------------------------------------------------
// Persisted configuration
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Default)]
struct Settings {
    #[serde(default)]
    base_url: String,
    // Normally empty in config.json (token lives in the OS keychain).
    // Written as plaintext fallback only when keychain is unavailable.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    token: String,
    #[serde(default)]
    members: Vec<String>,
}

#[derive(Serialize)]
struct SettingsView {
    base_url: String,
    has_token: bool,
    members: Vec<String>,
}

impl From<&Settings> for SettingsView {
    fn from(s: &Settings) -> Self {
        SettingsView {
            base_url: s.base_url.clone(),
            has_token: !s.token.trim().is_empty(),
            members: s.members.clone(),
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

// ---------------------------------------------------------------------------
// Keychain helpers
// ---------------------------------------------------------------------------

const KEYRING_SERVICE: &str = "pr-dashboard";

fn read_keyring_token(base_url: &str) -> Option<String> {
    if base_url.is_empty() {
        return None;
    }
    keyring::Entry::new(KEYRING_SERVICE, base_url)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|t| !t.is_empty())
}

fn write_keyring_token(base_url: &str, token: &str) -> Result<(), String> {
    if base_url.is_empty() {
        return Err("Cannot save token: no base URL configured.".into());
    }
    keyring::Entry::new(KEYRING_SERVICE, base_url)
        .map_err(|e| format!("Keychain error: {e}"))?
        .set_password(token)
        .map_err(|e| format!("Keychain write failed: {e}"))
}

fn delete_keyring_token(base_url: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, base_url) {
        let _ = entry.delete_credential();
    }
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

fn read_settings(app: &tauri::AppHandle) -> Settings {
    let mut s = if let Ok(p) = config_path(app) {
        if let Ok(data) = fs::read_to_string(&p) {
            serde_json::from_str::<Settings>(&data).unwrap_or_default()
        } else {
            Settings::default()
        }
    } else {
        Settings::default()
    };

    // Keychain takes priority. If config.json has a plaintext fallback token,
    // try to migrate it to keychain and clean up the config file.
    if let Some(keychain_token) = read_keyring_token(&s.base_url) {
        if !s.token.is_empty() {
            // Keychain works and config has stale plaintext — clean it up.
            s.token = String::new();
            let _ = write_settings(app, &s);
        }
        s.token = keychain_token;
        return s;
    }

    // Keychain unavailable or no entry yet. If config.json has a plaintext
    // token (old format or fallback), try to migrate it to keychain now.
    if !s.token.is_empty() && !s.base_url.is_empty() {
        let plaintext_token = s.token.clone();
        if write_keyring_token(&s.base_url, &plaintext_token).is_ok()
            && read_keyring_token(&s.base_url).is_some()
        {
            // Migration confirmed: remove plaintext from config.
            s.token = String::new();
            let _ = write_settings(app, &s);
            s.token = plaintext_token;
        }
        // Whether migration succeeded or not, s.token is set — return it.
    }

    s
}

fn write_settings(app: &tauri::AppHandle, s: &Settings) -> Result<(), String> {
    let p = config_path(app)?;
    // token is skip_serializing so it never lands in config.json.
    let data = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(p, data).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

fn api_base(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.is_empty() {
        return String::new();
    }
    let host_only = b
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    if host_only == "github.com" || host_only == "www.github.com" || host_only == "api.github.com" {
        return "https://api.github.com".to_string();
    }
    if b.ends_with("/api/v3") {
        return b.to_string();
    }
    let with_scheme = if b.starts_with("http://") || b.starts_with("https://") {
        b.to_string()
    } else {
        format!("https://{}", b)
    };
    format!("{}/api/v3", with_scheme)
}

/// Extract a human-friendly error string from a GitHub API error response.
fn github_error(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
            if status.as_u16() == 403 {
                let lower = msg.to_lowercase();
                if lower.contains("rate limit") || lower.contains("secondary rate") {
                    return format!(
                        "GitHub rate limit reached — wait a minute then refresh. ({})",
                        msg
                    );
                }
            }
            return format!("GitHub API error {status}: {msg}");
        }
    }
    let snippet: String = body.chars().take(400).collect();
    format!("GitHub API returned {status}: {snippet}")
}

fn github_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .build()
        .map_err(|e| format!("Could not create HTTP client: {e}"))
}

/// Paginate `search/issues`. Returns raw `items` JSON values.
async fn search_issues(
    client: &reqwest::Client,
    api: &str,
    token: &str,
    query: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut page: u32 = 1;
    loop {
        let url = format!("{}/search/issues", api);
        let page_str = page.to_string();
        let resp = client
            .get(&url)
            .query(&[
                ("q", query),
                ("per_page", "100"),
                ("page", page_str.as_str()),
            ])
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "pr-dashboard")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {e}"))?;

        if !status.is_success() {
            return Err(github_error(status, &text));
        }

        let v: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("Bad JSON from GitHub: {e}"))?;
        let items = v
            .get("items")
            .and_then(|i| i.as_array())
            .cloned()
            .unwrap_or_default();
        let n = items.len();
        out.extend(items);

        if n < 100 || page >= 10 {
            break;
        }
        page += 1;
    }
    Ok(out)
}

/// Paginate a list endpoint that returns a top-level JSON array (e.g. team members).
async fn fetch_list(
    client: &reqwest::Client,
    api: &str,
    token: &str,
    path: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut page: u32 = 1;
    loop {
        let url = format!("{}/{}", api, path.trim_start_matches('/'));
        let page_str = page.to_string();
        let resp = client
            .get(&url)
            .query(&[("per_page", "100"), ("page", page_str.as_str())])
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "pr-dashboard")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("Request failed: {e}"))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {e}"))?;

        if !status.is_success() {
            return Err(github_error(status, &text));
        }

        let items: Vec<serde_json::Value> =
            serde_json::from_str(&text).map_err(|e| format!("Bad JSON from GitHub: {e}"))?;
        let n = items.len();
        out.extend(items);

        if n < 100 {
            break;
        }
        page += 1;
    }
    Ok(out)
}

fn url_set(items: &[serde_json::Value]) -> HashSet<String> {
    items
        .iter()
        .filter_map(|i| {
            i.get("html_url")
                .and_then(|u| u.as_str())
                .map(|x| x.to_string())
        })
        .collect()
}

#[derive(Serialize)]
struct Pr {
    title: String,
    number: i64,
    repo: String,
    author: String,
    url: String,
    created_at: String,
    updated_at: String,
    /// "awaiting" | "approved" | "changes_requested"
    review_status: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> SettingsView {
    SettingsView::from(&read_settings(&app))
}

#[tauri::command]
fn save_connection(
    app: tauri::AppHandle,
    base_url: String,
    token: String,
) -> Result<SettingsView, String> {
    let mut s = read_settings(&app);
    let old_url = s.base_url.clone();
    s.base_url = base_url.trim().to_string();

    if !token.trim().is_empty() {
        s.token = token.trim().to_string();
        // Try keychain; fall back to plaintext in config.json if unavailable.
        let keychain_ok = write_keyring_token(&s.base_url, &s.token).is_ok()
            && read_keyring_token(&s.base_url).is_some();
        if keychain_ok {
            // Write config without the token (keychain holds it).
            let tok = s.token.clone();
            s.token = String::new();
            write_settings(&app, &s)?;
            s.token = tok;
        } else {
            // Keychain unavailable: store plaintext in config.json.
            write_settings(&app, &s)?;
        }
        if old_url != s.base_url && !old_url.is_empty() {
            delete_keyring_token(&old_url);
        }
    } else {
        write_settings(&app, &s)?;
    }

    Ok(SettingsView::from(&s))
}

#[tauri::command]
fn get_members(app: tauri::AppHandle) -> Vec<String> {
    read_settings(&app).members
}

#[tauri::command]
fn add_member(app: tauri::AppHandle, login: String) -> Result<Vec<String>, String> {
    let login = login.trim().trim_start_matches('@').to_string();
    if login.is_empty() {
        return Err("Username is empty.".into());
    }
    let mut s = read_settings(&app);
    if !s.members.iter().any(|m| m.eq_ignore_ascii_case(&login)) {
        s.members.push(login);
        s.members.sort_by_key(|m| m.to_lowercase());
        write_settings(&app, &s)?;
    }
    Ok(s.members)
}

#[tauri::command]
fn remove_member(app: tauri::AppHandle, login: String) -> Result<Vec<String>, String> {
    let mut s = read_settings(&app);
    s.members.retain(|m| !m.eq_ignore_ascii_case(login.trim()));
    write_settings(&app, &s)?;
    Ok(s.members)
}

/// Import all members of a GitHub team into the tracked list.
/// `team_slug` must be in `org/team-slug` format.
#[tauri::command]
async fn import_team(app: tauri::AppHandle, team_slug: String) -> Result<Vec<String>, String> {
    let s = read_settings(&app);
    if s.base_url.trim().is_empty() || s.token.trim().is_empty() {
        return Err("Configure the GitHub host and token in Settings first.".into());
    }
    let api = api_base(&s.base_url);
    if api.is_empty() {
        return Err("The GitHub host looks invalid.".into());
    }

    let slug = team_slug.trim().trim_start_matches('/');
    let parts: Vec<&str> = slug.splitn(2, '/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err("Team slug must be in org/team-slug format.".into());
    }
    let (org, team) = (parts[0], parts[1]);

    let client = github_client()?;
    let path = format!("orgs/{}/teams/{}/members", org, team);
    let items = fetch_list(&client, &api, &s.token, &path).await?;

    let logins: Vec<String> = items
        .iter()
        .filter_map(|i| {
            i.get("login")
                .and_then(|l| l.as_str())
                .map(|l| l.to_string())
        })
        .collect();

    if logins.is_empty() {
        return Err(format!("No members found in {}/{}.", org, team));
    }

    let mut s = read_settings(&app);
    for login in &logins {
        if !s.members.iter().any(|m| m.eq_ignore_ascii_case(login)) {
            s.members.push(login.clone());
        }
    }
    s.members.sort_by_key(|m| m.to_lowercase());
    write_settings(&app, &s)?;
    Ok(s.members)
}

#[tauri::command]
async fn fetch_prs(app: tauri::AppHandle) -> Result<Vec<Pr>, String> {
    let s = read_settings(&app);
    if s.base_url.trim().is_empty() || s.token.trim().is_empty() {
        return Err("Set the GitHub host and token in Settings first.".into());
    }
    let api = api_base(&s.base_url);
    if api.is_empty() {
        return Err("The GitHub host looks invalid.".into());
    }
    if s.members.is_empty() {
        return Ok(vec![]);
    }

    let client = github_client()?;
    let mut by_url: HashMap<String, Pr> = HashMap::new();

    for member in &s.members {
        let base_q = format!("is:pr is:open draft:false archived:false author:{}", member);

        // Fetch all open PRs and both review-state subsets in parallel would
        // exceed the search API's secondary rate limit; run them sequentially.
        let items = search_issues(&client, &api, &s.token, &base_q).await?;

        let changes_set = url_set(
            &search_issues(
                &client,
                &api,
                &s.token,
                &format!("{} review:changes_requested", base_q),
            )
            .await?,
        );
        let approved_set = url_set(
            &search_issues(
                &client,
                &api,
                &s.token,
                &format!("{} review:approved", base_q),
            )
            .await?,
        );

        for it in items {
            let url = it
                .get("html_url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string();
            if url.is_empty() {
                continue;
            }

            let review_status = if changes_set.contains(&url) {
                "changes_requested"
            } else if approved_set.contains(&url) {
                "approved"
            } else {
                "awaiting"
            }
            .to_string();

            let repo = it
                .get("repository_url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .split("/repos/")
                .nth(1)
                .unwrap_or("")
                .to_string();

            let pr = Pr {
                title: it
                    .get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or("(untitled)")
                    .to_string(),
                number: it.get("number").and_then(|x| x.as_i64()).unwrap_or(0),
                repo,
                author: it
                    .get("user")
                    .and_then(|u| u.get("login"))
                    .and_then(|x| x.as_str())
                    .unwrap_or(member)
                    .to_string(),
                url: url.clone(),
                created_at: it
                    .get("created_at")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                updated_at: it
                    .get("updated_at")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                review_status,
            };
            by_url.insert(url, pr);
        }
    }

    let mut prs: Vec<Pr> = by_url.into_values().collect();
    prs.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(prs)
}

#[tauri::command]
async fn approve_pr(
    app: tauri::AppHandle,
    owner_repo: String,
    pr_number: i64,
    comment: String,
) -> Result<(), String> {
    let s = read_settings(&app);
    let api = api_base(&s.base_url);
    if api.is_empty() || s.token.trim().is_empty() {
        return Err("Not configured.".into());
    }
    let client = github_client()?;
    let url = format!("{}/repos/{}/pulls/{}/reviews", api, owner_repo, pr_number);
    let body = serde_json::json!({ "body": comment, "event": "APPROVE" });
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", s.token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "pr-dashboard")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Err(github_error(status, &text))
    }
}

#[tauri::command]
async fn close_pr(
    app: tauri::AppHandle,
    owner_repo: String,
    pr_number: i64,
) -> Result<(), String> {
    let s = read_settings(&app);
    let api = api_base(&s.base_url);
    if api.is_empty() || s.token.trim().is_empty() {
        return Err("Not configured.".into());
    }
    let client = github_client()?;
    let url = format!("{}/repos/{}/pulls/{}", api, owner_repo, pr_number);
    let body = serde_json::json!({ "state": "closed" });
    let resp = client
        .patch(&url)
        .header("Authorization", format!("Bearer {}", s.token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "pr-dashboard")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Err(github_error(status, &text))
    }
}

#[tauri::command]
async fn close_pr_and_delete_branch(
    app: tauri::AppHandle,
    owner_repo: String,
    pr_number: i64,
) -> Result<(), String> {
    let s = read_settings(&app);
    let api = api_base(&s.base_url);
    if api.is_empty() || s.token.trim().is_empty() {
        return Err("Not configured.".into());
    }
    let client = github_client()?;

    let pr_url = format!("{}/repos/{}/pulls/{}", api, owner_repo, pr_number);
    let pr_resp = client
        .get(&pr_url)
        .header("Authorization", format!("Bearer {}", s.token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "pr-dashboard")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !pr_resp.status().is_success() {
        let status = pr_resp.status();
        let text = pr_resp.text().await.unwrap_or_default();
        return Err(github_error(status, &text));
    }
    let pr_json: serde_json::Value = pr_resp.json().await.map_err(|e| e.to_string())?;
    let head_ref = pr_json
        .get("head")
        .and_then(|h| h.get("ref"))
        .and_then(|r| r.as_str())
        .ok_or_else(|| "Could not determine branch name from PR.".to_string())?
        .to_string();

    let close_body = serde_json::json!({ "state": "closed" });
    let close_resp = client
        .patch(&pr_url)
        .header("Authorization", format!("Bearer {}", s.token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "pr-dashboard")
        .json(&close_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !close_resp.status().is_success() {
        let status = close_resp.status();
        let text = close_resp.text().await.unwrap_or_default();
        return Err(github_error(status, &text));
    }

    let ref_url = format!("{}/repos/{}/git/refs/heads/{}", api, owner_repo, head_ref);
    let del_resp = client
        .delete(&ref_url)
        .header("Authorization", format!("Bearer {}", s.token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "pr-dashboard")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if del_resp.status().is_success() || del_resp.status().as_u16() == 204 {
        Ok(())
    } else {
        let status = del_resp.status();
        let text = del_resp.text().await.unwrap_or_default();
        Err(github_error(status, &text))
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_connection,
            get_members,
            add_member,
            remove_member,
            import_team,
            fetch_prs,
            approve_pr,
            close_pr,
            close_pr_and_delete_branch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
