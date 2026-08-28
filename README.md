# Team PR Dashboard

A Tauri desktop app that shows all outstanding GitHub pull requests authored by
your team, across your whole GitHub Enterprise instance.

## What it does

- **Org-/enterprise-wide search** — finds every _open_ PR authored by anyone on
  your team list, in any repo the token can see. Drafts excluded.
- **3-state review badges** — each PR shows "Awaiting review", "Changes
  requested", or "Approved" based on three GitHub Search API qualifiers.
- **Age & staleness** — sorted oldest-first; ≥ 7 days is amber, ≥ 21 days is
  red. A "Last activity" column shows time since last update.
- **In-app team management** — add/remove individual GitHub usernames and
  persisted groups (`org/team-slug`, imports the team's current roster) from
  the Settings dialog.
- **Sidebar filter** — a collapsible sidebar (toggle with the ☰ button) lists
  every tracked user/group with checkboxes; checking one or more narrows the
  PR list to just their PRs, unchecking everything shows all of them again.
- **Filter & sort** — "Needs attention" toggle (hides approved PRs), free-text
  filter by title/repo/author, and click any column header to sort.
- **List or Card view** — toggle between the sortable table and a responsive
  card grid (columns adapt to window width, scrolls automatically when the
  list overflows). The choice is remembered across restarts.
- **Light/Dark/System theme** — set in Settings → Appearance. "System" follows
  the OS setting and updates live if you change it while the app is open.
- **PR actions** — each row has four icon buttons:
  - ✓ **Approve with comment** — opens a dialog, submits a GitHub review
  - 👁 **Open for review** — opens the PR's Files tab in the browser
  - ✕ **Close PR** — closes the PR via the API (with confirmation)
  - 🗑 **Close PR + branch** — closes the PR and deletes its head branch (with confirmation)
- **Auto-refresh** — fetches on a configurable interval (default 10 min). The
  countdown starts only after the previous fetch fully completes.
- **Github API Usage Tracking** - An Information Box at the bottom left tracks API Usage:
  - **Rate-limit pacing** — tracks `X-RateLimit-Remaining` headers; sleeps until
    the window resets when quota drops below 3 before making the next call. Large
    teams spread automatically across multiple 1-minute windows.
  - **Core API protection** — tracks the core rate limit
    (5000/hr) used by team imports, approve/close/delete-branch. If it's ever
    fully exhausted mid-action, the app waits out the reset and retries once
    automatically instead of surfacing a raw error.
- **Incremental rendering** — on refresh, only rows whose data has changed are
  updated. Unchanged rows are not touched; scroll position is preserved.
- **Loading animation** — a spinner shows while the very first batch of PRs is
  being fetched (app boot, or any refresh starting from an empty table).
  Later refreshes keep showing existing rows instead of blanking to a spinner.

## Prerequisites

1. **Rust** (stable ≥ 1.88) — https://rustup.rs
2. **Node.js 18+** and npm
3. Tauri OS dependencies — https://tauri.app/start/prerequisites/
   (Linux: WebKitGTK 4.1; macOS: Xcode CLI tools; Windows: WebView2 runtime)
4. A Github API Key with the Correct Permissions: [Github API Key Requirements](Github_API_Key_Requirements.md)
## Run it

```bash
npm install
npm run dev        # launch in development mode
```

Or use `make`:

```bash
make install       # npm install
make dev           # npm run dev
make help          # list all targets
```

On first launch a **Settings** dialog opens, organized like macOS System
Settings — a category list on the left (Connections, Users and Groups,
Appearance), each showing its own fields on the right. Under **Connections**,
enter:

- **GitHub Enterprise host** — e.g. `https://github.your-company.com`
  (`/api/v3` is appended automatically; plain `github.com` also works).
- **Personal Access Token** — classic PAT with `repo` scope (or fine-grained
  with pull-request read access). Create under _Settings → Developer settings →
  Personal access tokens_ on your GitHub host.
- **Auto-refresh interval** — minutes between automatic refreshes (minimum 1).

Then switch to **Users and Groups** to add team members by GitHub username,
or add a whole group with `org/team-slug`, and hit **Refresh**.

### Faster local dev cycles

Set `PRDASH_DEV_MAX_MEMBERS` to cap how many tracked members `fetch_prs`
actually queries, so you burn through far less of the real GitHub rate limit
while iterating on UI changes:

```bash
PRDASH_DEV_MAX_MEMBERS=2 npm run dev
```

Unset (the default), it queries everyone as normal. This only affects the
in-memory fetch for that run — it never touches persisted settings.

## Build distributable installers + executables

Supported targets: **Windows x64, macOS ARM64, macOS x64, Linux x64.**

```bash
make setup                  # one-time: add the 4 rustup cross-compilation targets
make build                  # native platform only (output: src-tauri/target/release/bundle/)
make build-macos-arm        # macOS Apple Silicon — raw binary + .dmg, staged in dist/macos-arm64/
make build-macos-x64        # macOS Intel — raw binary + .dmg, staged in dist/macos-x64/
make build-windows-x64      # Windows x64 — raw binary + .msi/.exe, staged in dist/windows-x64/  (must run on Windows)
make build-linux-x64        # Linux x64 — raw binary + .deb/.AppImage, staged in dist/linux-x64/  (must run on Linux)
make build-all              # run all 4 (Windows/Linux legs only succeed on that native OS)
```

Each `build-<target>` command stages **both** the raw executable and its
installer(s) into `dist/<target>/` for that platform. macOS can cross-build
both Mac arches from either Mac; Windows and Linux installers require running
on that native OS (matching the CI runner matrix below) — this mirrors Tauri's
own bundler, which needs the native platform's packaging tools (WiX/NSIS,
dpkg/AppImage).

CI builds all four targets automatically via `.github/workflows/build.yml`,
uploading both the installer(s) and the raw executable as build artifacts for
every push to `main`. A GitHub Release with all of them is created on any
`v*` tag push.

> To replace the placeholder icon: drop a square PNG at `assets/icon.png` and
> run `npm run tauri icon assets/icon.png`.

## Where things live

| Path | Purpose |
|---|---|
| `ui/` | Frontend — plain HTML/CSS/JS, no build step |
| `src-tauri/src/main.rs` | Entire Rust backend: config, GitHub API, commands |
| `src-tauri/Cargo.toml` | Rust dependencies |
| `Makefile` | Build shortcuts for all platforms |
| `dist/<target>/` | Staged local build output (raw executable + installer), gitignored |
| `.github/workflows/build.yml` | CI/CD for all 4 platform builds |

Config and settings are stored in:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/com.byron.prdashboard/config.json` |
| Linux | `~/.config/com.byron.prdashboard/config.json` |
| Windows | `%APPDATA%\com.byron.prdashboard\config.json` |

## Security

The PAT is stored in the **OS keychain** when possible (macOS Keychain, Windows
Credential Manager, Linux Secret Service). On unsigned dev builds the keychain
may be unavailable; the app falls back to plaintext in `config.json` in the app
config directory above. In either case the token never leaves your machine
except in `Authorization: Bearer` headers sent to your GitHub host, and it is
never sent to the frontend webview.

## How outstanding PRs are found

For each team member the app runs three sequential `GET /search/issues` queries:

```
is:pr is:open draft:false archived:false author:<member>                      # all open
is:pr is:open draft:false archived:false author:<member> review:changes_requested
is:pr is:open draft:false archived:false author:<member> review:approved
```

Results are merged and de-duplicated by PR URL. Review status is determined by
set membership: changes_requested wins over approved; anything else is "awaiting
review". The GitHub Search API caps results at 1 000 per query (10 pages × 100),
which the app paginates through automatically.
