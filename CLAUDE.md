# CLAUDE.md

Guidance for Claude Code working in this repo. Read `ENGINEERING.md` for full
handover context and the current TODO list.

## Project

Tauri v2 desktop app: a dashboard of outstanding GitHub PRs authored by a
user-managed team, across a GitHub Enterprise instance. See `README.md` for the
user-facing description.

## Architecture (one-liner)

Plain HTML/JS frontend in `ui/` calls Rust `#[tauri::command]`s in
`src-tauri/src/main.rs` via `window.__TAURI__.core.invoke`; the Rust side talks
to the GitHub Enterprise REST API with `reqwest` and persists config as JSON.

## Commands

```bash
npm install
npm run dev                    # run the app (Tauri dev)
npm run build                  # produce installers
cd src-tauri && cargo check    # compile-check the backend (do this first!)
cd src-tauri && cargo fmt      # format Rust
```

## Where to make changes

- **UI / rendering / filters / sorting:** `ui/main.js` (+ `ui/index.html`,
  `ui/styles.css`). No build step — edit and re-run.
- **GitHub queries, config, new commands:** `src-tauri/src/main.rs`. Register any
  new command in the `tauri::generate_handler![...]` list in `main()`.
- **Permissions for new plugins:** `src-tauri/capabilities/default.json`.
- **Window / bundle config:** `src-tauri/tauri.conf.json`.

## Conventions & gotchas

- Frontend has **no framework and no bundler** — keep it vanilla unless
  intentionally migrating to Vite (would require setting
  `build.beforeDevCommand` + `build.devUrl` in `tauri.conf.json`).
- JS `invoke` args are **camelCase**; Rust params are **snake_case** (Tauri
  converts). E.g. `invoke("save_connection", { baseUrl, token })` →
  `fn save_connection(base_url, token)`.
- Never send the PAT to the frontend. `get_settings` returns `has_token: bool`.
- All GitHub HTTP stays in Rust (keeps the token out of the webview, avoids
  CORS).
- **The Rust has not been compiled yet** — run `cargo check` before trusting it.
- Search API `review:required` is the current "awaiting review" signal; see
  ENGINEERING.md TODO for upgrading to real review decisions.

## Do not

- Commit `node_modules/`, `src-tauri/target/`, or `src-tauri/gen/` (see
  `.gitignore`).
- Hardcode any host or token — everything comes from in-app settings stored in
  the OS app-config dir.
