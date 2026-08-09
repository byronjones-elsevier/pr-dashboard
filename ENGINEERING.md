# ENGINEERING.md — handover notes

Handover for continuing the **Team PR Dashboard** in a Claude Code / terminal
session. Last updated 2026-08-08.

## What this is

A Tauri v2 desktop app that lists all outstanding GitHub pull requests authored
by a user-managed team, across a GitHub **Enterprise** instance.

- **Form factor:** Tauri desktop app (Rust backend + system WebView).
- **Scope:** enterprise-/org-wide open PRs by any team member, in any repo the
  token can see. Drafts excluded.
- **Team list:** add/remove individual GitHub usernames, or add/remove a
  persisted group backed by `org/team-slug` (imports the team's current
  roster). Managed from the Settings dialog; persisted to a local config file.
- **Sidebar filter:** collapsible sidebar lists every tracked user/group as a
  checkbox; checking one or more narrows the PR list to their PRs.
- **List/Card view:** a toolbar toggle switches between the table and a
  responsive card grid; both are kept reconciled in the DOM simultaneously
  (see `renderTable()`) so switching is instant with no re-fetch.
- **Loading overlay:** `setLoading()` shows a spinner in place of the
  list/card views only when `prs.length === 0` going into a `fetch_prs` call
  (initial boot, or any refresh starting from empty) — subsequent refreshes
  keep the existing rows visible via the incremental reconciliation instead.
- **Auth:** GitHub Enterprise base URL + Personal Access Token, entered in-app.
  Stored in OS keychain; plaintext config.json fallback for unsigned builds.

## Tech stack

- **Shell:** Tauri v2 (Rust backend + system WebView).
- **Frontend:** plain HTML/CSS/JS in `ui/` — **no build step, no framework**.
  `withGlobalTauri: true` → `window.__TAURI__.core.invoke` available directly.
- **Backend:** Rust, single file `src-tauri/src/main.rs`.
  - HTTP: `reqwest` (async, `rustls-tls`, no OpenSSL).
  - JSON: `serde` / `serde_json`.
  - Async sleep for rate-limit pacing: `tokio` (`time` feature).
  - OS keychain: `keyring` v3.
  - Opens URLs in the external browser: `tauri-plugin-opener`.
- Config persisted as JSON in the OS app-config dir (see README for paths).

## File map

```
pr-dashboard/
├── package.json                     # npm scripts: dev / build / tauri
├── Makefile                         # build shortcuts for all 5 platforms
├── README.md                        # user-facing setup & usage
├── ENGINEERING.md                   # this file
├── AGENTS.md                        # AI agent guidance
├── CLAUDE.md                        # repo guide for Claude Code
├── .github/workflows/build.yml      # CI: builds all 4 targets; releases on v* tags
├── ui/                              # frontend (frontendDist target)
│   ├── index.html
│   ├── styles.css
│   └── main.js                      # all UI logic, invoke() calls
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json              # window, bundle, withGlobalTauri
    ├── capabilities/default.json   # permissions: core:default, opener:default
    ├── icons/                       # generated placeholder icon set
    └── src/main.rs                  # backend + all #[tauri::command]s
```

## Backend commands (Rust ↔ JS contract)

All invoked from `ui/main.js` via `invoke("<name>", args)`. Tauri converts JS
camelCase args to Rust snake_case.

| Command | Args (JS) | Returns | Notes |
|---|---|---|---|
| `get_settings` | – | `SettingsView` | Token never sent to UI |
| `save_connection` | `{ baseUrl, token, refreshIntervalMins? }` | `SettingsView` | Empty `token` keeps the saved one; `refreshIntervalMins` min 1 |
| `get_members` | – | `string[]` | Effective (deduped union of individual + group) members |
| `add_member` | `{ login }` | `SettingsView` | Strips `@`, case-insensitive dedupe, sorted |
| `remove_member` | `{ login }` | `SettingsView` | Only removes from the individual list |
| `add_group` | `{ teamSlug }` | `SettingsView` | Slug must be `org/team-slug`; imports/refreshes that group's roster |
| `remove_group` | `{ slug }` | `SettingsView` | Untracks the group's members unless tracked elsewhere |
| `save_ui_prefs` | `{ sidebarVisible, viewMode }` | `SettingsView` | Persists sidebar visibility + list/card view choice |
| `fetch_prs` | – | `FetchResult` | See below |
| `approve_pr` | `{ ownerRepo, prNumber, comment }` | `()` | POSTs APPROVE review |
| `close_pr` | `{ ownerRepo, prNumber }` | `()` | PATCHes state=closed |
| `close_pr_and_delete_branch` | `{ ownerRepo, prNumber }` | `()` | GETs head ref, closes PR, DELETEs ref |

### Types

```
Group = { slug: string, members: string[] }   // slug is "org/team-slug"

SettingsView = { base_url: string, has_token: bool, members: string[], groups: Group[],
                  refresh_interval_mins: u32, sidebar_visible: bool, view_mode: "list" | "card" }

Pr = { title, number, repo, author, url, created_at, updated_at,
       review_status: "awaiting" | "approved" | "changes_requested" }

RateLimitStatus = { search_remaining: i64, search_limit: i64, search_reset: i64 }

FetchResult = { prs: Pr[], rate_limit: RateLimitStatus }
```

`effective_members()` (Rust) / `effectiveLogins()` (JS) compute the same
case-insensitive-deduped union of individual `members` and every group's
roster — this is the set `fetch_prs` actually queries. The sidebar's
select/deselect filter is purely client-side: `filterSelection` holds
`"user:<login>"` / `"group:<slug>"` keys; empty selection means no filter.

### How PRs are fetched

For each member, **three** sequential `GET /search/issues` calls:

```
is:pr is:open draft:false archived:false author:<member>                     # all open
is:pr is:open draft:false archived:false author:<member> review:changes_requested
is:pr is:open draft:false archived:false author:<member> review:approved
```

Results merged and de-duped by `html_url`. `review_status` is set by set
membership: `changes_requested` wins; `approved` next; everything else is
`awaiting`. Paginated to 1 000 results (per_page=100, max 10 pages).

#### Rate-limit pacing

`search_issues()` captures `X-RateLimit-Remaining` and `X-RateLimit-Reset` from
every response header. `fetch_prs` tracks the running remaining count; when it
drops below 3 before the next call, it sleeps until `reset + 2s` and then
continues. This allows large teams (>10 members, >30 calls needed) to
automatically spread across multiple 1-minute rate-limit windows. There is also
a 250 ms inter-member polite delay to avoid GitHub's secondary rate limit.

A `GET /rate_limit` call is made before and after the fetch (uses the core API
quota, not search) to return current state to the UI.

## Key decisions / rationale

- **No frontend build step** — keeps the project dependency-light. Migration
  path: add Vite + a framework, set `build.beforeDevCommand`/`devUrl` in
  `tauri.conf.json`.
- **All GitHub calls in Rust** — avoids CORS, keeps the PAT out of the DOM.
  `get_settings` deliberately returns `has_token: bool`.
- **3-state review via Search API qualifiers** — avoids per-PR REST calls.
  `review:changes_requested` and `review:approved` are reliable signals for
  the common case. A more precise signal would be the GraphQL `reviewDecision`
  field — see Possible future work.
- **Opener plugin for links** — Tauri WebView won't open `<a>` externally.
  `main.js` intercepts `.pr-title` clicks and calls
  `invoke("plugin:opener|open_url", { url })`.
- **Recursive `setTimeout` for auto-refresh** — `setInterval` fires at a fixed
  wall-clock cadence regardless of how long the fetch takes. The recursive
  approach starts the countdown only after the previous fetch fully resolves.
- **Keyed DOM reconciliation** — `renderTable()` uses a shared `reconcileKeyed()`
  helper (keyed by PR URL) for both the table body and the card grid. On
  refresh: unchanged nodes are skipped entirely, changed ones updated in
  place, new ones inserted, gone ones removed. Scroll position is preserved
  in whichever view is visible.
- **Card grid is CSS-only responsive** — `grid-template-columns: repeat(auto-fill,
  minmax(300px, 1fr))` reflows column count purely from container width; no
  resize listener needed. `overflow-y: auto` on `.card-wrap` gives automatic
  scrollbars.

## Verified (2026-07-31)

- Rust compiles clean on toolchain 1.97.1 (`cargo check` 0 errors/warnings).
- End-to-end confirmed: 62 open PRs across 12 team members loaded from real GHE;
  rate-limit pacing across multiple windows working correctly.
- PR action buttons tested (approve modal, review link, close confirmations).
- Incremental DOM update confirmed: rows update in place on refresh.

## Verified (2026-08-08)

- Settings dialog Groups/Individual users CRUD confirmed against real GHE data
  (64 open PRs, 13 tracked users).
- Sidebar select/deselect filter confirmed: checking a user narrows the table
  to their PRs; unchecking restores the full list.
- Sidebar show/hide toggle confirmed both directions, including the
  `sidebar-collapsed` single-column grid fallback and that the choice persists
  across app restarts via `save_ui_prefs`.
- List/Card view toggle confirmed: card grid renders 3 columns at 1280px width
  and collapses to 1 column at 760px with no code change (pure CSS grid
  reflow); switching views is instant since both DOM trees stay reconciled.
- Loading spinner confirmed showing during the initial fetch window (caught
  via a polling screenshot loop) and clearing correctly once data arrives.
  Sidebar-toggle button relocated to the top-left (directly above the
  sidebar) with a proper panel-style SVG icon per user feedback.

## Remaining risks / notes

- **Window label** — `tauri.conf.json` defines one window with no explicit
  `label`; Tauri defaults to `main`. If capabilities ever fail to apply, add
  `"label": "main"` explicitly.
- **Keychain on unsigned builds** — macOS keychain requires a code-signed
  binary. Dev builds fall back to plaintext in config.json automatically; this
  is resolved once the app is code-signed for distribution.
- **Icons are generated placeholders** — replace via
  `npm run tauri icon assets/icon.png` before distributing.
- **Code signing not yet configured** — required for macOS notarization and
  Windows SmartScreen bypass. Certificates must be injected as repository secrets
  and wired into the GitHub Actions workflow.

## Possible future work

- **Richer review state** — use GraphQL `reviewDecision` or per-PR REST reviews
  for a more precise signal than Search API qualifiers.
- **Per-member "last synced" timestamp** — show when each member's PRs were last
  fetched.
- **Notification on new PR** — OS-level notification when a new PR appears for a
  tracked member (Tauri notification plugin).
- **Signed/notarized releases** — wire Apple Developer and Windows Authenticode
  certificates into the CI workflow.

## Build & run

```bash
npm install
npm run dev                    # launch dev mode
npm run build                  # native installer
cd src-tauri && cargo check    # fast Rust compile check
make help                      # show all Makefile targets
```

Prereqs: Rust stable ≥ 1.88, Node 18+, Tauri OS deps
(https://tauri.app/start/prerequisites/).

### Cross-platform builds (local + CI)

Four targets: Windows x64, macOS ARM64, macOS x64, Linux x64 (Windows ARM64
was dropped from the Makefile/CI/rustup-targets — not part of the current
target list; previously present under `build-windows-arm`).

- `make build-<target>` runs `tauri build --target <triple>`, then stages the
  raw executable **and** the full `bundle/` tree (installers) into
  `dist/<target>/` via the internal `stage` target — one predictable output
  location with both deliverables. `make build-all` chains all four; the
  Windows/Linux legs only succeed when run on that native OS, since Tauri's
  installer bundlers (WiX/NSIS, dpkg/AppImage) require the matching platform.
- CI (`.github/workflows/build.yml`) runs one job per target on the matching
  native GitHub-hosted runner (macos-14, macos-13, windows-latest,
  ubuntu-latest — no cross-compilation containers). Each job now also renames
  the raw binary to `pr-dashboard-<target>[.exe]` before
  `upload-artifact` — every target's raw binary is otherwise named identically
  (`pr-dashboard`/`pr-dashboard.exe`), and the `release` job downloads with
  `merge-multiple: true`, which flattens all artifacts into one directory and
  would silently clobber same-named files across platforms without the rename.
- `help`'s target-listing regex was `[a-zA-Z_-]+` (no digits) — this silently
  dropped every target with a digit in its name (`build-macos-x64`,
  `build-linux-x64`, etc.) from `make help` output. Fixed to
  `[a-zA-Z0-9_-]+`. Pre-existing bug, unrelated to the Windows ARM64 removal.
