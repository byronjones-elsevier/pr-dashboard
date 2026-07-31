# Team PR Dashboard

A small Tauri desktop app that shows all outstanding GitHub pull requests
authored by your team, across your whole GitHub Enterprise instance. Add and
remove team members right inside the app.

## What it does

- **Org-/enterprise-wide search** — finds every _open_ PR authored by anyone on
  your team list, in any repo you can see (drafts excluded).
- **Awaiting-review flag** — each PR is marked "Awaiting review" when GitHub
  reports a review is still required (`review:required`), or "Reviewed"
  otherwise.
- **Age & staleness** — PRs are sorted oldest-first; anything open ≥ 7 days is
  amber and ≥ 21 days is red, so stale PRs stand out. A "Last activity" column
  shows time since the PR was last updated.
- **In-app team management** — add or remove GitHub usernames from the sidebar;
  the list is saved locally and each member shows their open-PR count.
- **Filter & sort** — "Awaiting review only" toggle, free-text filter (title /
  repo / author), and click any column header to sort.

## Prerequisites

1. **Rust** (stable) — https://rustup.rs
2. **Node.js 18+** and npm
3. Tauri OS dependencies for your platform — see
   https://tauri.app/start/prerequisites/ (on Linux this is WebKitGTK etc.; on
   macOS the Xcode command-line tools; on Windows the WebView2 runtime, which is
   preinstalled on Windows 11).

## Run it

```bash
cd pr-dashboard
npm install
npm run dev        # launches the app in development mode
```

On first launch a **Settings** dialog opens. Enter:

- **GitHub Enterprise host** — e.g. `https://github.your-company.com`
  (the `/api/v3` REST root is appended automatically; plain `github.com` also
  works and resolves to `https://api.github.com`).
- **Personal Access Token** — a classic PAT with the `repo` scope (or a
  fine-grained token with pull-request read access to the relevant repos).
  Create one under _Settings → Developer settings → Personal access tokens_ on
  your GitHub host.

Then add team members by GitHub username in the left sidebar and hit
**Refresh**.

## Build a distributable

```bash
npm run build      # produces installers under src-tauri/target/release/bundle/
```

> macOS `.icns` and Windows `.ico` icons are included. If you want to swap in
> your own icon, drop a square PNG at `assets/icon.png` and run
> `npm run tauri icon assets/icon.png` to regenerate the full set.

## Where things live

- `ui/` — the frontend (plain HTML/CSS/JS, no build step).
- `src-tauri/src/main.rs` — the Rust backend: config storage plus the GitHub
  API calls.
- Your settings and team list are stored in the app config directory:
  - macOS: `~/Library/Application Support/com.byron.prdashboard/config.json`
  - Linux: `~/.config/com.byron.prdashboard/config.json`
  - Windows: `%APPDATA%\com.byron.prdashboard\config.json`

## Security note

The Personal Access Token is stored **in plaintext** in `config.json` in the
app config directory above (it never leaves your machine except in requests to
your GitHub host). This is fine for a personal tool. If you'd like it kept in
the OS keychain instead, that's a small change — add the
[`keyring`](https://crates.io/crates/keyring) crate and store the token there
rather than in the JSON file. Ask and I can wire that up.

## How "outstanding" is defined

For each member the app runs two GitHub searches:

```
is:pr is:open draft:false archived:false author:<member>                  # all open PRs
is:pr is:open draft:false archived:false author:<member> review:required  # the awaiting-review subset
```

Results are merged and de-duplicated by PR URL. The GitHub search API caps
results at 1000 per query, which the app paginates through.
