#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

// ---------------------------------------------------------------------------
// Persisted configuration
// ---------------------------------------------------------------------------

fn default_refresh_mins() -> u32 {
    10
}

fn default_true() -> bool {
    true
}

fn default_view_mode() -> String {
    "list".to_string()
}

/// A persisted GitHub team: `slug` is "org/team-slug", `members` is the
/// team's roster as of the last import/refresh.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Group {
    #[serde(default)]
    slug: String,
    #[serde(default)]
    members: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Settings {
    #[serde(default)]
    base_url: String,
    // Normally empty in config.json (token lives in the OS keychain).
    // Written as plaintext fallback only when keychain is unavailable.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    token: String,
    // Individually-added users (not sourced from an imported team).
    #[serde(default)]
    members: Vec<String>,
    #[serde(default)]
    groups: Vec<Group>,
    #[serde(default = "default_refresh_mins")]
    refresh_interval_mins: u32,
    #[serde(default = "default_true")]
    sidebar_visible: bool,
    #[serde(default = "default_view_mode")]
    view_mode: String,
}

/// Union of individually-added members and every group's roster, deduped
/// case-insensitively. This is the set of logins fetch_prs actually queries.
fn effective_members(s: &Settings) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for login in s.members.iter().chain(s.groups.iter().flat_map(|g| g.members.iter())) {
        let key = login.to_lowercase();
        if seen.insert(key) {
            out.push(login.clone());
        }
    }
    out.sort_by_key(|m| m.to_lowercase());
    out
}

#[derive(Serialize)]
struct SettingsView {
    base_url: String,
    has_token: bool,
    members: Vec<String>,
    groups: Vec<Group>,
    refresh_interval_mins: u32,
    sidebar_visible: bool,
    view_mode: String,
}

impl From<&Settings> for SettingsView {
    fn from(s: &Settings) -> Self {
        SettingsView {
            base_url: s.base_url.clone(),
            has_token: !s.token.trim().is_empty(),
            members: s.members.clone(),
            groups: s.groups.clone(),
            refresh_interval_mins: if s.refresh_interval_mins == 0 {
                default_refresh_mins()
            } else {
                s.refresh_interval_mins
            },
            sidebar_visible: s.sidebar_visible,
            view_mode: if s.view_mode.is_empty() {
                default_view_mode()
            } else {
                s.view_mode.clone()
            },
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

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

struct SearchResponse {
    items: Vec<serde_json::Value>,
    /// Remaining calls in the current window from X-RateLimit-Remaining, or -1 if absent.
    rate_remaining: i64,
    /// Window-reset Unix timestamp from X-RateLimit-Reset, or 0 if absent.
    rate_reset: i64,
}

/// Paginate `search/issues`. Returns items plus the rate-limit headers from the last page.
async fn search_issues(
    client: &reqwest::Client,
    api: &str,
    token: &str,
    query: &str,
) -> Result<SearchResponse, String> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut page: u32 = 1;
    let mut rate_remaining: i64 = -1;
    let mut rate_reset: i64 = 0;
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

        // Capture rate-limit headers before consuming the body.
        if let Some(v) = resp.headers().get("x-ratelimit-remaining") {
            rate_remaining = v.to_str().ok().and_then(|s| s.parse().ok()).unwrap_or(rate_remaining);
        }
        if let Some(v) = resp.headers().get("x-ratelimit-reset") {
            rate_reset = v.to_str().ok().and_then(|s| s.parse().ok()).unwrap_or(rate_reset);
        }

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
    Ok(SearchResponse { items: out, rate_remaining, rate_reset })
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

/// Snapshot of the GitHub Search API rate-limit window.
#[derive(Serialize, Clone)]
struct RateLimitStatus {
    search_remaining: i64,
    search_limit: i64,
    /// Unix timestamp when the current window resets.
    search_reset: i64,
}

#[derive(Serialize)]
struct FetchResult {
    prs: Vec<Pr>,
    rate_limit: RateLimitStatus,
}

async fn fetch_rate_limit(
    client: &reqwest::Client,
    api: &str,
    token: &str,
) -> Result<RateLimitStatus, String> {
    let url = format!("{}/rate_limit", api);
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "pr-dashboard")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let search = body
        .pointer("/resources/search")
        .ok_or("Missing search resource in rate_limit response")?;
    Ok(RateLimitStatus {
        search_remaining: search
            .get("remaining")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        search_limit: search.get("limit").and_then(|v| v.as_i64()).unwrap_or(30),
        search_reset: search.get("reset").and_then(|v| v.as_i64()).unwrap_or(0),
    })
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
    refresh_interval_mins: Option<u32>,
) -> Result<SettingsView, String> {
    let mut s = read_settings(&app);
    let old_url = s.base_url.clone();
    s.base_url = base_url.trim().to_string();
    if let Some(mins) = refresh_interval_mins {
        s.refresh_interval_mins = mins.max(1);
    }

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
    effective_members(&read_settings(&app))
}

#[tauri::command]
fn add_member(app: tauri::AppHandle, login: String) -> Result<SettingsView, String> {
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
    Ok(SettingsView::from(&s))
}

#[tauri::command]
fn remove_member(app: tauri::AppHandle, login: String) -> Result<SettingsView, String> {
    let mut s = read_settings(&app);
    s.members.retain(|m| !m.eq_ignore_ascii_case(login.trim()));
    write_settings(&app, &s)?;
    Ok(SettingsView::from(&s))
}

/// Add (or refresh) a persisted group backed by a GitHub team.
/// `team_slug` must be in `org/team-slug` format.
#[tauri::command]
async fn add_group(app: tauri::AppHandle, team_slug: String) -> Result<SettingsView, String> {
    let s = read_settings(&app);
    if s.base_url.trim().is_empty() || s.token.trim().is_empty() {
        return Err("Configure the GitHub host and token in Settings first.".into());
    }
    let api = api_base(&s.base_url);
    if api.is_empty() {
        return Err("The GitHub host looks invalid.".into());
    }

    let slug = team_slug.trim().trim_start_matches('/').to_string();
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
    if let Some(g) = s.groups.iter_mut().find(|g| g.slug.eq_ignore_ascii_case(&slug)) {
        g.members = logins;
    } else {
        s.groups.push(Group { slug, members: logins });
    }
    s.groups.sort_by_key(|g| g.slug.to_lowercase());
    write_settings(&app, &s)?;
    Ok(SettingsView::from(&s))
}

#[tauri::command]
fn remove_group(app: tauri::AppHandle, slug: String) -> Result<SettingsView, String> {
    let mut s = read_settings(&app);
    s.groups.retain(|g| !g.slug.eq_ignore_ascii_case(slug.trim()));
    write_settings(&app, &s)?;
    Ok(SettingsView::from(&s))
}

#[tauri::command]
fn save_ui_prefs(
    app: tauri::AppHandle,
    sidebar_visible: bool,
    view_mode: String,
) -> Result<SettingsView, String> {
    let mut s = read_settings(&app);
    s.sidebar_visible = sidebar_visible;
    s.view_mode = view_mode;
    write_settings(&app, &s)?;
    Ok(SettingsView::from(&s))
}

#[tauri::command]
async fn fetch_prs(app: tauri::AppHandle) -> Result<FetchResult, String> {
    let s = read_settings(&app);
    if s.base_url.trim().is_empty() || s.token.trim().is_empty() {
        return Err("Set the GitHub host and token in Settings first.".into());
    }
    let api = api_base(&s.base_url);
    if api.is_empty() {
        return Err("The GitHub host looks invalid.".into());
    }

    let client = github_client()?;

    // Fetch initial rate-limit state (uses the core API, not the search quota).
    let initial_rl = fetch_rate_limit(&client, &api, &s.token).await?;

    let members = effective_members(&s);
    if members.is_empty() {
        return Ok(FetchResult { prs: vec![], rate_limit: initial_rl });
    }

    // Track remaining search quota from response headers so we can sleep
    // between calls when the window is nearly exhausted, allowing the app
    // to pace itself across multiple 1-minute windows automatically.
    let mut remaining = initial_rl.search_remaining;
    let mut reset_at = initial_rl.search_reset;

    let mut by_url: HashMap<String, Pr> = HashMap::new();

    for (i, member) in members.iter().enumerate() {
        // Before each member's 3 calls: sleep if the window is exhausted,
        // or add a short inter-member pause to avoid secondary rate limits.
        if remaining < 3 && remaining >= 0 {
            let wait = ((reset_at - unix_now()) + 2).max(1) as u64;
            tokio::time::sleep(tokio::time::Duration::from_secs(wait)).await;
            // Remaining will be refreshed from the next response header.
            remaining = 30;
        } else if i > 0 {
            tokio::time::sleep(tokio::time::Duration::from_millis(250)).await;
        }

        let base_q = format!("is:pr is:open draft:false archived:false author:{}", member);

        // Three sequential search calls per member; pace between each one.
        let r1 = search_issues(&client, &api, &s.token, &base_q).await?;
        if r1.rate_remaining >= 0 { remaining = r1.rate_remaining; }
        if r1.rate_reset > 0 { reset_at = r1.rate_reset; }

        if remaining < 3 && remaining >= 0 {
            let wait = ((reset_at - unix_now()) + 2).max(1) as u64;
            tokio::time::sleep(tokio::time::Duration::from_secs(wait)).await;
            remaining = 30;
        }

        let r2 = search_issues(
            &client, &api, &s.token,
            &format!("{} review:changes_requested", base_q),
        ).await?;
        if r2.rate_remaining >= 0 { remaining = r2.rate_remaining; }
        if r2.rate_reset > 0 { reset_at = r2.rate_reset; }

        if remaining < 3 && remaining >= 0 {
            let wait = ((reset_at - unix_now()) + 2).max(1) as u64;
            tokio::time::sleep(tokio::time::Duration::from_secs(wait)).await;
            remaining = 30;
        }

        let r3 = search_issues(
            &client, &api, &s.token,
            &format!("{} review:approved", base_q),
        ).await?;
        if r3.rate_remaining >= 0 { remaining = r3.rate_remaining; }
        if r3.rate_reset > 0 { reset_at = r3.rate_reset; }

        let items = r1.items;
        let changes_set = url_set(&r2.items);
        let approved_set = url_set(&r3.items);

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

    // Re-fetch rate limit so the UI shows the state *after* consuming quota.
    let rate_limit = fetch_rate_limit(&client, &api, &s.token)
        .await
        .unwrap_or(initial_rl);

    Ok(FetchResult { prs, rate_limit })
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
            add_group,
            remove_group,
            save_ui_prefs,
            fetch_prs,
            approve_pr,
            close_pr,
            close_pr_and_delete_branch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
