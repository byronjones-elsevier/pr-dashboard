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
    base_url: String, // e.g. https://github.example.com  (API is derived from this)
    #[serde(default)]
    token: String, // GitHub Enterprise Personal Access Token
    #[serde(default)]
    members: Vec<String>, // GitHub usernames to track
}

/// What we send to the frontend when it asks for settings — the token is
/// reported only as a boolean so it never has to live in the DOM.
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

fn read_settings(app: &tauri::AppHandle) -> Settings {
    if let Ok(p) = config_path(app) {
        if let Ok(s) = fs::read_to_string(p) {
            if let Ok(cfg) = serde_json::from_str::<Settings>(&s) {
                return cfg;
            }
        }
    }
    Settings::default()
}

fn write_settings(app: &tauri::AppHandle, s: &Settings) -> Result<(), String> {
    let p = config_path(app)?;
    let data = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(p, data).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

/// Derive the REST API base from a user-supplied host.
/// - github.com          -> https://api.github.com
/// - any Enterprise host -> https://<host>/api/v3
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
    // If the user already pasted the API root, respect it.
    if b.ends_with("/api/v3") {
        return b.to_string();
    }
    // Normalise: ensure a scheme.
    let with_scheme = if b.starts_with("http://") || b.starts_with("https://") {
        b.to_string()
    } else {
        format!("https://{}", b)
    };
    format!("{}/api/v3", with_scheme)
}

/// Run a `search/issues` query, following pagination up to the search API's
/// 1000-result ceiling. Returns the raw `items` JSON values.
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
            let snippet: String = text.chars().take(400).collect();
            return Err(format!("GitHub API returned {status}: {snippet}"));
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

#[derive(Serialize)]
struct Pr {
    title: String,
    number: i64,
    repo: String,
    author: String,
    url: String,
    created_at: String,
    updated_at: String,
    awaiting_review: bool,
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
    s.base_url = base_url.trim().to_string();
    // Empty token means "keep the existing one" so users can update the URL
    // without re-pasting the PAT.
    if !token.trim().is_empty() {
        s.token = token.trim().to_string();
    }
    write_settings(&app, &s)?;
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
    if !s
        .members
        .iter()
        .any(|m| m.eq_ignore_ascii_case(&login))
    {
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

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("Could not create HTTP client: {e}"))?;

    // Deduplicate across members (a PR can be co-authored / show up twice).
    let mut by_url: HashMap<String, Pr> = HashMap::new();

    for member in &s.members {
        let base_q = format!(
            "is:pr is:open draft:false archived:false author:{}",
            member
        );

        // All open PRs authored by this member.
        let items = search_issues(&client, &api, &s.token, &base_q).await?;

        // The subset that still requires a review (our "awaiting review" flag).
        let await_q = format!("{} review:required", base_q);
        let await_items = search_issues(&client, &api, &s.token, &await_q).await?;
        let await_set: HashSet<String> = await_items
            .iter()
            .filter_map(|i| {
                i.get("html_url")
                    .and_then(|u| u.as_str())
                    .map(|x| x.to_string())
            })
            .collect();

        for it in items {
            let url = it
                .get("html_url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string();
            if url.is_empty() {
                continue;
            }
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
                awaiting_review: await_set.contains(&url),
            };
            by_url.insert(url, pr);
        }
    }

    let mut prs: Vec<Pr> = by_url.into_values().collect();
    // Oldest first — the most stale PRs bubble to the top.
    prs.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(prs)
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
            fetch_prs
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
