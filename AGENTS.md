# AGENTS.md — agent guidance for Team PR Dashboard

Instructions for Claude Code and other AI agents working in this repository.
Read `ENGINEERING.md` for full architectural context.

## Repo layout (quick reference)

```
pr-dashboard/
├── Makefile                     # build shortcuts (make help)
├── .github/workflows/build.yml  # CI for all 5 platform targets
├── ui/                          # frontend: index.html, styles.css, main.js
└── src-tauri/
    └── src/main.rs              # entire Rust backend
```

## Before writing any code

1. `cd src-tauri && cargo check` — confirm the backend compiles.
2. Read `ENGINEERING.md` — describes current state, decisions, and known risks.

## Where changes live

| What | File(s) |
|---|---|
| UI layout / style | `ui/index.html`, `ui/styles.css` |
| UI logic, filters, sorting, `invoke()` calls | `ui/main.js` |
| GitHub API, config, new Tauri commands | `src-tauri/src/main.rs` |
| New Tauri plugin permissions | `src-tauri/capabilities/default.json` |
| Window / bundle / Tauri config | `src-tauri/tauri.conf.json` |

## Rust backend conventions

- All commands are `#[tauri::command]` fns registered in
  `tauri::generate_handler![...]` in `main()`. A new command requires both the
  fn **and** a registration entry.
- JS args are camelCase; Rust params are snake_case — Tauri converts.
  E.g. `invoke("save_connection", { baseUrl, token })` →
  `fn save_connection(base_url: String, token: String)`.
- **Never return the PAT to the frontend.** `get_settings` returns `has_token:
  bool`. Follow this pattern for any new settings command.
- All GitHub HTTP stays in Rust — avoids CORS and keeps the token out of the DOM.
- After editing Rust: `cargo fmt` then `cargo check` before committing.

### Key Rust types (src/main.rs)

```rust
Settings          // persisted: base_url, token (keychain/fallback), members, refresh_interval_mins
SettingsView      // what JS receives: base_url, has_token, members, refresh_interval_mins
Pr                // { title, number, repo, author, url, created_at, updated_at, review_status }
RateLimitStatus   // { search_remaining, search_limit, search_reset }
FetchResult       // { prs: Vec<Pr>, rate_limit: RateLimitStatus }
SearchResponse    // internal: { items, rate_remaining, rate_reset } — returned by search_issues()
```

### Rate-limit pacing (important)

`search_issues()` returns `SearchResponse` which includes `rate_remaining` and
`rate_reset` captured from response headers. `fetch_prs` tracks these and sleeps
until `reset + 2s` whenever `remaining < 3` before the next call. **Do not**
remove or bypass this pacing — it is what allows large teams to work without
hitting 403s. The 250 ms inter-member delay guards against GitHub's secondary
(undocumented) rate limit.

## JS frontend conventions

- No framework, no bundler — plain ES6. `window.__TAURI__.core.invoke` is
  available because `withGlobalTauri: true` is set in `tauri.conf.json`.
- Keep all UI logic in `main.js`. Do not add additional JS files.
- Staleness thresholds: `STALE_DAYS = 7`, `VERY_STALE_DAYS = 21` at top of file.
- Auto-refresh uses recursive `setTimeout` via `scheduleNextRefresh()` — do NOT
  replace with `setInterval`. The countdown starts after each fetch resolves.

### DOM reconciliation (important)

`renderTable()` does **not** wipe `prBody.innerHTML`. It keeps a `Map<url, tr>`
of live rows and reconciles:

- `makePrRow(p)` — creates a `<tr data-pr-url>` on first render; stores a
  snapshot in `tr._snap`.
- `syncPrRow(tr, p)` — updates `innerHTML` only when `title`, `review_status`,
  `created_at`, or `updated_at` has changed; skips entirely otherwise.
- Rows for PRs absent from the new API result are removed via `tr.remove()`.

**Do not** add `prBody.innerHTML = ""` anywhere — it breaks the incremental
update behaviour.

## Security constraints

- The PAT lives in the OS keychain (primary) or `config.json` (plaintext
  fallback for unsigned dev builds). Never log, expose, or return it from any
  Tauri command. Only use it in `Authorization: Bearer` headers.
- No `eval`, no dynamic script injection in the frontend.
- Do not relax the Tauri CSP without documenting the reason in `ENGINEERING.md`.

## Testing

No automated test suite. Before declaring a change done:

1. `cargo check` — mandatory.
2. `cargo fmt -- --check` — flag formatting drift.
3. `npm run dev` smoke test — launch the app, exercise the changed path.

Add a comment above each new Tauri command fn with the expected JS call
signature so the frontend contract is easy to audit.

## Common pitfalls

- **Opener plugin arg:** `invoke("plugin:opener|open_url", { url })` — the arg
  is `url`, not `path`.
- **`api_base()` in Rust** handles `github.com` vs enterprise host resolution.
  Pass the raw host URL from settings; do not pre-process it in JS.
- **Search API ceiling:** 1 000 results per query. `search_issues()` already
  paginates; do not re-implement pagination.
- **`fetch_prs` returns `FetchResult`**, not `Pr[]`. JS: `const { prs, rate_limit } = await invoke("fetch_prs")`.
- **`save_connection` takes `refreshIntervalMins?: number`** as an optional
  third arg. JS: `invoke("save_connection", { baseUrl, token, refreshIntervalMins })`.
- **`autoRefreshMs`** is a module-level variable in `main.js` updated on
  settings save. `scheduleNextRefresh()` reads it on every tick, so the new
  interval takes effect after the next post-save refresh.
- **`ownerRepo`** passed to action commands is the `repo` field from `Pr`
  (format: `owner/repo`, e.g. `elsevierPTG/hub`), not just the repo name.
