# AGENTS.md — agent guidance for Team PR Dashboard

Instructions for Claude Code and other AI agents working in this repository.
Read `ENGINEERING.md` for full architectural context and the current TODO list.

## Repo layout (quick reference)

```
pr-dashboard/
├── ui/             # frontend: index.html, styles.css, main.js (vanilla JS, no build)
└── src-tauri/
    └── src/main.rs # entire Rust backend: config, GitHub API, Tauri commands
```

## Before writing any code

1. Run `cd src-tauri && cargo check` to confirm the backend compiles.
2. Read `ENGINEERING.md` — it describes the current state, known risks, and TODO
   priority. Do not re-derive decisions that are already documented there.

## Where changes live

| What you're changing | File(s) |
|---|---|
| UI layout / style | `ui/index.html`, `ui/styles.css` |
| UI logic, filters, sorting, invoke() calls | `ui/main.js` |
| GitHub API calls, config persistence, new commands | `src-tauri/src/main.rs` |
| New Tauri plugin permissions | `src-tauri/capabilities/default.json` |
| Window / bundle / Tauri config | `src-tauri/tauri.conf.json` |

## Rust backend conventions

- All Tauri commands are `#[tauri::command]` fns registered in
  `tauri::generate_handler![...]` in `main()`. Adding a command requires both
  the fn and a registration entry.
- JS invokes use camelCase args; Rust params are snake_case — Tauri converts.
  E.g. `invoke("save_connection", { baseUrl, token })` maps to
  `fn save_connection(base_url: String, token: String)`.
- **Never** return the PAT to the frontend. `get_settings` returns `has_token:
  bool`. Any new settings command must follow the same pattern.
- All GitHub HTTP stays in Rust to avoid CORS and keep the token out of the DOM.
- After editing Rust, run `cargo fmt` then `cargo check` before committing.

## JS frontend conventions

- No framework, no bundler — plain ES modules via `<script type="module">`.
  `window.__TAURI__.core.invoke` is available because `withGlobalTauri: true`
  is set in `tauri.conf.json`.
- Keep UI logic in `main.js`. Do not add additional JS files unless a migration
  to a build tool (Vite) is planned and the user agrees.
- Staleness thresholds live as constants at the top of `main.js`:
  `STALE_DAYS=7`, `VERY_STALE_DAYS=21`. Adjust there, not inline.

## Security constraints

- The PAT is stored in plaintext in the OS app-config dir (`config.json`).
  Do not log, expose, or transmit it anywhere except the `Authorization: Bearer`
  header on outbound requests to the GHE API.
- No eval, no dynamic script injection in the frontend.
- `tauri.conf.json` CSP is managed by Tauri defaults — do not relax it without
  a specific reason documented in `ENGINEERING.md`.

## Testing

There is currently no automated test suite. Before declaring a change done:

1. `cargo check` (Rust) — mandatory.
2. `cargo fmt -- --check` (Rust) — flag any formatting drift.
3. `npm run dev` manual smoke test — launch the app, exercise the changed path.

When adding new Tauri commands, add a comment above the fn with the expected
JS call signature so the frontend contract is easy to audit.

## Common pitfalls

- **Opener plugin arg:** `invoke("plugin:opener|open_url", { url })` — the arg
  is `url`, not `path`. Verify in the browser console if links don't open.
- **API base derivation:** `api_base()` in `main.rs` handles `github.com` vs
  enterprise hosts. Pass the raw host URL from settings; do not pre-process it
  in JS.
- **Search API ceiling:** the search API caps at 1000 results (10 pages ×
  100). `search_issues()` already handles pagination; do not re-implement it.
- **`review:required` semantics:** this flag means "a review is required and
  has not yet been given." It does NOT distinguish "changes requested." See
  ENGINEERING.md TODO #4 for the upgrade path.
