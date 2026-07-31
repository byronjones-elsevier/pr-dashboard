# ENGINEERING.md — handover notes

Handover for continuing the **Team PR Dashboard** in a Claude Code / terminal
session. This captures the current state, decisions, and what still needs doing.
Written 2026-07-31.

## What this is

A Tauri v2 desktop app that lists all outstanding GitHub pull requests authored
by a user-managed team, across a GitHub **Enterprise** instance. Product
requirements as agreed with the user (Byron):

- **Form factor:** Tauri desktop app.
- **Scope:** enterprise-/org-wide — "anything they authored" (open PRs by any
  team member, in any repo the token can see). Drafts excluded.
- **"Outstanding" definition:** open + authored by a team member, with an
  **awaiting-review** flag, and **age/staleness** shown.
- **Team list:** starts empty; add/remove GitHub usernames from inside the app;
  persisted to a local config file.
- **Auth:** GitHub Enterprise base URL + Personal Access Token, entered in-app,
  stored locally.

## Tech stack

- **Shell:** Tauri v2 (Rust backend + system webview).
- **Frontend:** plain HTML/CSS/JS in `ui/` — **no build step, no framework**.
  Uses `withGlobalTauri: true`, so `window.__TAURI__.core.invoke` is available
  directly.
- **Backend:** Rust, single file `src-tauri/src/main.rs`.
  - HTTP via `reqwest` (async, `rustls-tls`, no OpenSSL dependency).
  - JSON via `serde` / `serde_json`.
  - `tauri-plugin-opener` to open PR URLs in the external browser.
- Config persisted as JSON in the OS app-config dir (see README for paths).

## File map

```
pr-dashboard/
├── package.json                     # npm scripts: dev / build / tauri
├── README.md                        # user-facing setup & usage
├── ENGINEERING.md                   # this file
├── CLAUDE.md                        # repo guide for Claude Code
├── ui/                              # frontend (frontendDist target)
│   ├── index.html
│   ├── styles.css
│   └── main.js                      # all UI logic, invoke() calls
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json              # window, bundle, withGlobalTauri
    ├── capabilities/default.json    # permissions: core:default, opener:default
    ├── icons/                       # generated placeholder icon set
    └── src/main.rs                  # backend + all #[tauri::command]s
```

## Backend commands (Rust ↔ JS contract)

All invoked from `ui/main.js` via `invoke("<name>", args)`. Tauri converts JS
camelCase args to Rust snake_case.

| Command           | Args (JS)                    | Returns            | Notes |
|-------------------|------------------------------|--------------------|-------|
| `get_settings`    | –                            | `SettingsView`     | `{ base_url, has_token, members }` — token never sent to the UI |
| `save_connection` | `{ baseUrl, token }`         | `SettingsView`     | Empty `token` keeps the saved one |
| `get_members`     | –                            | `string[]`         | |
| `add_member`      | `{ login }`                  | `string[]`         | Strips leading `@`, case-insensitive dedupe, sorted |
| `remove_member`   | `{ login }`                  | `string[]`         | |
| `fetch_prs`       | –                            | `Pr[]`             | Errors as `Err(String)` surfaced in the UI banner |

`Pr = { title, number, repo, author, url, created_at, updated_at, awaiting_review }`.

### How PRs are fetched

For each member, two `GET /search/issues` calls against `<api>/search/issues`
(`<api>` = `https://api.github.com` for github.com, else `<host>/api/v3`):

```
is:pr is:open draft:false archived:false author:<member>                  # all open
is:pr is:open draft:false archived:false author:<member> review:required  # awaiting review subset
```

Results merged and de-duped by PR html_url; `awaiting_review = true` when the URL
appears in the second set. Paginated to the search API's 1000-result ceiling
(per_page=100, capped at 10 pages). Sorted oldest-first server-side; the UI can
re-sort. Age/staleness is computed in JS (`main.js`: STALE_DAYS=7,
VERY_STALE_DAYS=21).

## Key decisions / rationale

- **No frontend build step** — keeps the app dependency-light and easy to hand
  off. If it grows, migrating `ui/` to Vite + a framework is the natural step
  (Tauri's `build.beforeDevCommand`/`devUrl` would then point at the dev
  server).
- **All GitHub calls in Rust, not the webview** — avoids CORS and keeps the PAT
  out of the DOM. `get_settings` deliberately returns `has_token: bool` rather
  than the token.
- **`review:required` for "awaiting review"** — simplest reliable signal from
  the search API without per-PR REST calls. Note it means "a review is required
  and not yet given"; it does NOT distinguish "changes requested". See TODO.
- **Opener plugin** for links — a Tauri webview won't open `<a>` externally on
  its own. `main.js` intercepts `.pr-title` clicks and calls
  `invoke("plugin:opener|open_url", { url })`.

## Verified (2026-07-31)

- **Rust compiles clean** — upgraded toolchain from 1.87.0 → 1.97.1 (deps
  required ≥1.88); `cargo check` and `npm run dev` both pass with 0 errors.
- **End-to-end confirmed** against the real GHE host: 11 open PRs loaded for
  `byronjones-elsevier`, review badges, age, and last-activity columns all
  rendering correctly.
- **`invoke("plugin:opener|open_url", { url })` arg is correct** — confirmed
  against `tauri-plugin-opener-2.5.4/src/init-iife.js`; the plugin uses `url`.

## Remaining risks / notes

- **Window label** — `tauri.conf.json` defines one window without an explicit
  `label`; Tauri defaults it to `main`, which the capability targets. If the
  capability ever fails to apply, set `"label": "main"` explicitly.
- **PAT stored in plaintext** in `config.json`. Acceptable for a personal tool;
  see TODO for keychain.
- **Icons are generated placeholders** (a simple merge-graph motif). Replace via
  `npm run tauri icon assets/icon.png` before distributing.

## TODO / next steps (rough priority)

1. ~~`cargo check` / `npm run dev` and fix any compile errors.~~ ✓ Done
2. ~~Confirm end-to-end against the real GHE host.~~ ✓ Done
3. **Optional — keychain storage** for the PAT: add the `keyring` crate, store
   the token there instead of in `config.json` (keep `base_url`/`members` in
   JSON). The user explicitly asked to be offered this.
4. **Optional — richer review state:** distinguish "changes requested" vs "no
   review yet" vs "approved". Cleanest via the GraphQL API `reviewDecision`
   field, or per-PR `GET /repos/{owner}/{repo}/pulls/{n}/reviews`.
5. **Optional — auto-refresh** on an interval, and a per-member "last synced"
   indicator.
6. **Optional — rate-limit handling:** surface `X-RateLimit-Remaining` and back
   off / show a friendly message on 403 secondary-rate-limit responses. Right
   now a non-200 is shown verbatim in the banner.
7. **Optional — team presets / import** (e.g. seed from a GitHub team slug via
   `GET /orgs/{org}/teams/{team}/members`).

## Build & run

```bash
npm install
npm run dev        # dev run
npm run build      # installers -> src-tauri/target/release/bundle/
cd src-tauri && cargo check   # fast compile check without launching
```

Prereqs: Rust stable (>= 1.77), Node 18+, and Tauri OS deps
(https://tauri.app/start/prerequisites/).
