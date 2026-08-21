const { invoke } = window.__TAURI__.core;

// Open external links (PR pages) in the user's default browser via the
// opener plugin — a Tauri webview won't do this for a normal <a> click.
function openExternal(url) {
  invoke("plugin:opener|open_url", { url }).catch((e) => showBanner(String(e)));
}

function closeHelpMenu() {
  el("help-menu").classList.add("hidden");
}

function openHelpMenu() {
  el("help-menu").classList.remove("hidden");
}

async function openHelpPage() {
  const helpUrl = new URL("./help.html", window.location.href).toString();
  openExternal(helpUrl);
  closeHelpMenu();
}

async function openGitHubRepo() {
  openExternal("https://github.com/ByronJones-Elsevier/pr-dashboard/");
  closeHelpMenu();
}

async function openReportIssue() {
  openExternal("https://github.com/byronjones-elsevier/pr-dashboard/issues");
  closeHelpMenu();
}

async function openVersionDialog() {
  try {
    const info = await invoke("get_app_info");
    el("version-app").textContent = `${info.app_name} ${info.app_version}`;
    el("version-tauri").textContent = info.tauri_version;
    el("version-opener").textContent = info.opener_version;
  } catch (e) {
    el("version-app").textContent = "Unavailable";
    el("version-tauri").textContent = "Unavailable";
    el("version-opener").textContent = "Unavailable";
    showBanner(String(e));
  }
  closeHelpMenu();
  el("version-modal").classList.remove("hidden");
}

function closeVersionDialog() {
  el("version-modal").classList.add("hidden");
}

function openFirstRunDialog() {
  el("first-run-modal").classList.remove("hidden");
}

function closeFirstRunDialog() {
  el("first-run-modal").classList.add("hidden");
}

async function markFirstRunSeen() {
  try {
    window.__cfg = await invoke("mark_first_run_seen");
  } catch (e) {
    console.warn("Could not persist first-run flag:", e);
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let members = []; // individually-added users
let groups = []; // [{ slug, members: [...] }] persisted GitHub teams
let prs = [];
let sortKey = "created_at";
let sortDir = "asc"; // asc = oldest first
let needsAttentionOnly = false;
let searchText = "";
let lastRateLimit = null; // RateLimitStatus from last fetch_prs call
let usageTickMs = 5000; // updated from settings on load
let usageTickTimer = null;
let sidebarVisible = true;
let viewMode = "list"; // "list" | "card"
let theme = "system"; // "light" | "dark" | "system"
let systemThemeMedia = null;
// Selected filter keys: "user:<login>" or "group:<slug>" (lowercased).
// Empty = nothing selected — fetchPrs() won't query anyone until the user
// checks at least one box.
let filterSelection = new Set();

const STALE_DAYS = 7;
const VERY_STALE_DAYS = 21;

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const filterList = el("filter-list");
const filterEmpty = el("filter-empty");
const prBody = el("pr-body");
const cardGrid = el("card-grid");
const listView = el("list-view");
const cardView = el("card-view");
const emptyState = el("empty-state");
const loadingOverlay = el("loading-overlay");
const banner = el("status-banner");
const summary = el("summary");
const lastRefresh = el("last-refresh");
const fetchBtn = el("fetch-btn");
const searchUsageValue = el("search-usage-value");
const searchUsageFill = el("search-usage-fill");
const searchUsageSub = el("search-usage-sub");
const coreUsageValue = el("core-usage-value");
const coreUsageFill = el("core-usage-fill");
const coreUsageSub = el("core-usage-sub");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Union of individually-added members and every group's roster, deduped
// case-insensitively. Mirrors effective_members() on the Rust side.
function effectiveLogins() {
  const seen = new Map();
  for (const m of members) seen.set(m.toLowerCase(), m);
  for (const g of groups) {
    for (const m of g.members) {
      if (!seen.has(m.toLowerCase())) seen.set(m.toLowerCase(), m);
    }
  }
  return Array.from(seen.values());
}

function daysSince(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
}

function humanAge(iso) {
  const d = daysSince(iso);
  if (d === null) return "—";
  if (d === 0) return "today";
  if (d === 1) return "1 day";
  if (d < 30) return `${d} days`;
  const months = Math.floor(d / 30);
  return months === 1 ? "1 month" : `${months} months`;
}

function ageClass(iso) {
  const d = daysSince(iso);
  if (d === null) return "";
  if (d >= VERY_STALE_DAYS) return "very-stale";
  if (d >= STALE_DAYS) return "stale";
  return "";
}

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]
  );
}

function showBanner(message, kind = "error") {
  banner.textContent = message;
  banner.className = `banner ${kind}`;
}
function clearBanner() {
  banner.className = "banner hidden";
}

function reviewBadge(status) {
  switch (status) {
    case "changes_requested":
      return `<span class="badge changes">Changes requested</span>`;
    case "approved":
      return `<span class="badge approved">Approved</span>`;
    default:
      return `<span class="badge awaiting">Awaiting review</span>`;
  }
}

// Fill a meter track: width = % of quota used, color escalates with severity.
function setMeterFill(fillEl, usedPct, critical, low) {
  fillEl.style.width = `${Math.max(0, Math.min(100, usedPct))}%`;
  fillEl.className = critical ? "meter-fill critical" : low ? "meter-fill low" : "meter-fill";
}

function updateSearchUsageMeter(rl) {
  if (!rl) {
    searchUsageValue.textContent = "—";
    setMeterFill(searchUsageFill, 0, false, false);
    searchUsageSub.textContent = "No data yet — click Fetch.";
    return;
  }
  const { search_limit, search_reset } = rl;
  const now = Math.floor(Date.now() / 1000);
  // GitHub's search quota is a fixed window, not a sliding average — once
  // real time passes the recorded reset, the true remaining quota is back
  // to the full limit even though we haven't re-fetched. Project that
  // locally instead of leaving the bar/counter frozen at stale numbers.
  const windowElapsed = search_reset > 0 && now >= search_reset;
  const remaining = windowElapsed ? search_limit : rl.search_remaining;
  const used = Math.max(0, search_limit - remaining);
  const needed = resolvedSelectedLogins().length * 3;
  const low = remaining < Math.max(needed * 2, 6); // < 2 fetches left
  const critical = remaining < needed;             // < 1 fetch left

  searchUsageValue.textContent = `${used} / ${search_limit} used`;
  setMeterFill(searchUsageFill, search_limit > 0 ? (used / search_limit) * 100 : 0, critical, low);

  const resetIn = Math.max(0, search_reset - now);
  searchUsageSub.textContent = windowElapsed
    ? "Full quota available"
    : resetIn > 0
    ? `Resets in ${resetIn}s`
    : "";
}

// Core API (5000/hr) backs every non-search call: team imports, approve/
// close/delete-branch. Thresholds are flat (not team-size-scaled like
// search's) since a single action only ever costs a handful of calls.
function updateCoreUsageMeter(rl) {
  if (!rl) {
    coreUsageValue.textContent = "—";
    setMeterFill(coreUsageFill, 0, false, false);
    coreUsageSub.textContent = "";
    return;
  }
  const { core_limit, core_reset } = rl;
  const now = Math.floor(Date.now() / 1000);
  // Same fixed-window projection as the search meter above.
  const windowElapsed = core_reset > 0 && now >= core_reset;
  const remaining = windowElapsed ? core_limit : rl.core_remaining;
  const used = Math.max(0, core_limit - remaining);
  const low = remaining < 100;
  const critical = remaining < 10;

  coreUsageValue.textContent = `${used} / ${core_limit} used`;
  setMeterFill(coreUsageFill, core_limit > 0 ? (used / core_limit) * 100 : 0, critical, low);

  const resetIn = Math.max(0, core_reset - now);
  coreUsageSub.textContent = windowElapsed
    ? "Full quota available"
    : resetIn > 0
    ? `Resets in ${Math.ceil(resetIn / 60)}m`
    : "";
}

// Re-renders both meters against the last fetched numbers on a timer, so the
// "resets in" countdown ticks down live. This never calls invoke() — it's a
// local repaint of lastRateLimit against the current clock, not a new fetch.
function scheduleUsageTick() {
  clearInterval(usageTickTimer);
  usageTickTimer = setInterval(() => {
    updateSearchUsageMeter(lastRateLimit);
    updateCoreUsageMeter(lastRateLimit);
  }, usageTickMs);
}

// ---------------------------------------------------------------------------
// Action icons (SVG)
// ---------------------------------------------------------------------------
const ICON_APPROVE = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.25"/><polyline points="5.25,8.25 7,10.5 10.75,5.75"/></svg>`;
const ICON_EYE    = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.667-5 7-5 7 5 7 5-2.667 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>`;
const ICON_CLOSE  = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="6.25"/><line x1="5.5" y1="5.5" x2="10.5" y2="10.5"/><line x1="10.5" y1="5.5" x2="5.5" y2="10.5"/></svg>`;
const ICON_TRASH  = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,4 14,4"/><path d="M5,4V3a1,1,0,0,1,1-1h4a1,1,0,0,1,1,1v1"/><path d="M13,4l-.867,9.2A1,1,0,0,1,11.14,14H4.86A1,1,0,0,1,3.867,13.2L3,4"/><line x1="6.5" y1="7" x2="6.5" y2="11"/><line x1="9.5" y1="7" x2="9.5" y2="11"/></svg>`;

// ---------------------------------------------------------------------------
// Approve modal state
// ---------------------------------------------------------------------------
let pendingApprove = null; // { ownerRepo, prNumber, prTitle }
let pendingConfirm = null; // callback to run on confirm

function openApproveModal(ownerRepo, prNumber, prTitle) {
  pendingApprove = { ownerRepo, prNumber };
  el("approve-pr-info").textContent = `${ownerRepo} #${prNumber} — ${prTitle}`;
  el("approve-comment").value = "";
  el("approve-modal").classList.remove("hidden");
  el("approve-comment").focus();
}

function closeApproveModal() {
  pendingApprove = null;
  el("approve-modal").classList.add("hidden");
}

async function submitApprove() {
  if (!pendingApprove) return;
  const { ownerRepo, prNumber } = pendingApprove;
  const comment = el("approve-comment").value.trim();
  const btn = el("approve-submit");
  btn.disabled = true;
  btn.textContent = "Approving…";
  try {
    await invoke("approve_pr", { ownerRepo, prNumber, comment });
    closeApproveModal();
    showBanner(`Approved PR #${prNumber}.`, "info");
    const pr = prs.find((p) => p.repo === ownerRepo && p.number === prNumber);
    if (pr) pr.review_status = "approved";
    renderTable();
  } catch (e) {
    showBanner(String(e));
    closeApproveModal();
  } finally {
    btn.disabled = false;
    btn.textContent = "Approve";
  }
}

function openConfirmModal(title, body, onConfirm) {
  pendingConfirm = onConfirm;
  el("confirm-title").textContent = title;
  el("confirm-body").textContent = body;
  el("confirm-modal").classList.remove("hidden");
}

function closeConfirmModal() {
  pendingConfirm = null;
  el("confirm-modal").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Export report (CSV / HTML)
// ---------------------------------------------------------------------------
function openExportModal() {
  const count = sortedFilteredPrs().length;
  el("export-body").textContent =
    `Exports the ${count} pull request${count === 1 ? "" : "s"} currently ` +
    `shown, honoring your search and filters.`;
  el("export-modal").classList.remove("hidden");
}

function closeExportModal() {
  el("export-modal").classList.add("hidden");
}

function csvField(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsvReport(list) {
  const headers = [
    "Title",
    "Number",
    "Repository",
    "Author",
    "Review status",
    "Created at",
    "Updated at",
    "URL",
  ];
  const rows = list.map((p) => [
    p.title,
    p.number,
    p.repo,
    p.author,
    p.review_status,
    p.created_at,
    p.updated_at,
    p.url,
  ]);
  return [headers, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n");
}

function buildHtmlReport(list) {
  const generated = new Date().toLocaleString();
  const rows = list
    .map(
      (p) => `      <tr>
        <td><a href="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a> <span class="pr-num">#${p.number}</span></td>
        <td>${escapeHtml(p.repo)}</td>
        <td>${escapeHtml(p.author)}</td>
        <td>${escapeHtml(p.review_status)}</td>
        <td>${escapeHtml(humanAge(p.created_at))}</td>
        <td>${escapeHtml(humanAge(p.updated_at))}</td>
      </tr>`
    )
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Team PR Dashboard — Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #1a1a1a; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  p.meta { color: #666; margin-top: 0; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #ddd; font-size: 13px; }
  th { background: #f4f4f5; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <h1>Team PR Dashboard — Report</h1>
  <p class="meta">Generated ${escapeHtml(generated)} · ${list.length} pull request${list.length === 1 ? "" : "s"}</p>
  <table>
    <thead>
      <tr><th>PR</th><th>Repository</th><th>Author</th><th>Review</th><th>Age</th><th>Last activity</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
}

async function exportReport(format) {
  const list = sortedFilteredPrs();
  const date = new Date().toISOString().slice(0, 10);
  const content = format === "csv" ? buildCsvReport(list) : buildHtmlReport(list);
  const defaultName = `pr-report-${date}.${format}`;
  closeExportModal();
  try {
    const saved = await invoke("export_report", { defaultName, content });
    if (saved) showBanner(`Report exported as ${format.toUpperCase()}.`, "info");
  } catch (e) {
    showBanner(`Export failed: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Team management (Settings dialog) + sidebar filter list
// ---------------------------------------------------------------------------
function prCountFor(login) {
  return prs.filter((p) => p.author.toLowerCase() === login.toLowerCase())
    .length;
}

function applyTeamUpdate(view) {
  members = view.members || [];
  groups = view.groups || [];
  renderTeamSettingsLists();
  renderSidebarFilter();
}

function renderTeamSettingsLists() {
  const groupList = el("settings-group-list");
  const groupEmpty = el("settings-group-empty");
  groupList.innerHTML = "";
  groupEmpty.classList.toggle("hidden", groups.length > 0);
  for (const g of groups) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="name">${escapeHtml(g.slug)}</span>
      <span class="count">${g.members.length} member${g.members.length === 1 ? "" : "s"}</span>
      <button class="remove-x" title="Remove ${escapeHtml(g.slug)}">✕</button>`;
    li.querySelector(".remove-x").addEventListener("click", () => removeGroup(g.slug));
    groupList.appendChild(li);
  }

  const memberListEl = el("settings-member-list");
  const memberEmptyEl = el("settings-member-empty");
  memberListEl.innerHTML = "";
  memberEmptyEl.classList.toggle("hidden", members.length > 0);
  for (const m of members) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="name">${escapeHtml(m)}</span>
      <button class="remove-x" title="Remove ${escapeHtml(m)}">✕</button>`;
    li.querySelector(".remove-x").addEventListener("click", () => removeMember(m));
    memberListEl.appendChild(li);
  }
}

// Sidebar checkboxes: checking a user/group narrows the PR list to their
// PRs (see selectedLogins()). Unchecking everything shows all PRs again.
function renderSidebarFilter() {
  filterList.innerHTML = "";
  filterEmpty.classList.toggle("hidden", groups.length > 0 || members.length > 0);

  const addRow = (key, name, count) => {
    const li = document.createElement("li");
    const checked = filterSelection.has(key) ? "checked" : "";
    li.innerHTML = `
      <label class="filter-row">
        <input type="checkbox" data-key="${escapeHtml(key)}" ${checked} />
        <span class="name">${escapeHtml(name)}</span>
        <span class="count">${count} PR${count === 1 ? "" : "s"}</span>
      </label>`;
    li.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) filterSelection.add(key);
      else filterSelection.delete(key);
      renderTable();
    });
    filterList.appendChild(li);
  };

  for (const g of groups) {
    const count = g.members.reduce((sum, m) => sum + prCountFor(m), 0);
    addRow(`group:${g.slug.toLowerCase()}`, g.slug, count);
  }
  for (const m of members) {
    addRow(`user:${m.toLowerCase()}`, m, prCountFor(m));
  }
}

async function addMember(login) {
  try {
    applyTeamUpdate(await invoke("add_member", { login }));
  } catch (e) {
    showBanner(String(e));
  }
}

async function removeMember(login) {
  try {
    applyTeamUpdate(await invoke("remove_member", { login }));
    prs = prs.filter((p) => p.author.toLowerCase() !== login.toLowerCase());
    renderTable();
  } catch (e) {
    showBanner(String(e));
  }
}

async function addGroup(teamSlug) {
  applyTeamUpdate(await invoke("add_group", { teamSlug }));
}

async function removeGroup(slug) {
  try {
    applyTeamUpdate(await invoke("remove_group", { slug }));
    // No re-fetch — just drop any cached PRs that are no longer tracked
    // by anyone (individually or via another group).
    const stillTracked = new Set(effectiveLogins().map((m) => m.toLowerCase()));
    prs = prs.filter((p) => stillTracked.has(p.author.toLowerCase()));
    renderTable();
  } catch (e) {
    showBanner(String(e));
  }
}

// Expands the sidebar filter selection (users + groups) into the set of
// logins it resolves to (lowercased). Empty selection resolves to an empty
// set — nothing selected means nothing shown and nothing fetched.
function selectedLogins() {
  const out = new Set();
  for (const m of members) {
    if (filterSelection.has(`user:${m.toLowerCase()}`)) out.add(m.toLowerCase());
  }
  for (const g of groups) {
    if (filterSelection.has(`group:${g.slug.toLowerCase()}`)) {
      for (const m of g.members) out.add(m.toLowerCase());
    }
  }
  return out;
}

// Same resolution as selectedLogins(), but returns the original-cased login
// strings — this is what gets sent to fetch_prs as the scope of the query.
function resolvedSelectedLogins() {
  const out = new Map(); // lowercase -> original case
  for (const m of members) {
    if (filterSelection.has(`user:${m.toLowerCase()}`)) out.set(m.toLowerCase(), m);
  }
  for (const g of groups) {
    if (filterSelection.has(`group:${g.slug.toLowerCase()}`)) {
      for (const m of g.members) {
        if (!out.has(m.toLowerCase())) out.set(m.toLowerCase(), m);
      }
    }
  }
  return Array.from(out.values());
}

// ---------------------------------------------------------------------------
// PR table
// ---------------------------------------------------------------------------
function sortedFilteredPrs() {
  let list = prs.slice();

  const logins = selectedLogins();
  list = list.filter((p) => logins.has(p.author.toLowerCase()));

  // "Needs attention" = awaiting review or changes have been requested.
  if (needsAttentionOnly) {
    list = list.filter((p) => p.review_status !== "approved");
  }

  if (searchText) {
    const q = searchText.toLowerCase();
    list = list.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.repo.toLowerCase().includes(q) ||
        p.author.toLowerCase().includes(q)
    );
  }

  list.sort((a, b) => {
    let av = a[sortKey];
    let bv = b[sortKey];
    av = String(av).toLowerCase();
    bv = String(bv).toLowerCase();
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });
  return list;
}

// Build the innerHTML for a single PR row.
function prRowHtml(p) {
  const filesUrl = escapeHtml(p.url + "/files");
  return `
    <td>
      <a class="pr-title" href="${escapeHtml(p.url)}" data-url="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a>
      <span class="pr-num">#${p.number}</span>
    </td>
    <td class="repo-cell">${escapeHtml(p.repo)}</td>
    <td>${escapeHtml(p.author)}</td>
    <td>${reviewBadge(p.review_status)}</td>
    <td class="age ${ageClass(p.created_at)}">${humanAge(p.created_at)}</td>
    <td class="age ${ageClass(p.updated_at)}">${humanAge(p.updated_at)}</td>
    <td class="actions-cell">
      <button class="action-btn approve"
        data-action="approve" data-repo="${escapeHtml(p.repo)}"
        data-num="${p.number}" data-title="${escapeHtml(p.title)}"
        title="Approve with comment">${ICON_APPROVE}</button>
      <button class="action-btn open-review"
        data-action="review" data-url="${filesUrl}"
        title="Open for review (files tab)">${ICON_EYE}</button>
      <button class="action-btn close-pr"
        data-action="close" data-repo="${escapeHtml(p.repo)}"
        data-num="${p.number}" data-title="${escapeHtml(p.title)}"
        title="Close PR">${ICON_CLOSE}</button>
      <button class="action-btn delete-branch"
        data-action="delete-branch" data-repo="${escapeHtml(p.repo)}"
        data-num="${p.number}" data-title="${escapeHtml(p.title)}"
        title="Close PR and delete branch">${ICON_TRASH}</button>
    </td>`;
}

// Create a fresh <tr> keyed by PR URL.
function makePrRow(p) {
  const tr = document.createElement("tr");
  tr.dataset.prUrl = p.url;
  tr.innerHTML = prRowHtml(p);
  tr._snap = p;
  return tr;
}

// Update an existing row only when something visible has changed.
function syncPrRow(tr, p) {
  const s = tr._snap;
  if (
    s &&
    s.title === p.title &&
    s.review_status === p.review_status &&
    s.created_at === p.created_at &&
    s.updated_at === p.updated_at
  )
    return;
  tr.innerHTML = prRowHtml(p);
  tr._snap = p;
}

// Build the innerHTML for a single PR card (card view).
function prCardHtml(p) {
  const filesUrl = escapeHtml(p.url + "/files");
  return `
    <div class="card-head">
      <a class="pr-title" href="${escapeHtml(p.url)}" data-url="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a>
      <span class="pr-num">#${p.number}</span>
    </div>
    <div class="card-repo repo-cell">${escapeHtml(p.repo)}</div>
    <div class="card-meta">
      <span class="card-author">${escapeHtml(p.author)}</span>
      ${reviewBadge(p.review_status)}
    </div>
    <div class="card-ages">
      <span class="age ${ageClass(p.created_at)}">Opened ${humanAge(p.created_at)} ago</span>
      <span class="age ${ageClass(p.updated_at)}">Active ${humanAge(p.updated_at)} ago</span>
    </div>
    <div class="card-actions">
      <button class="action-btn approve"
        data-action="approve" data-repo="${escapeHtml(p.repo)}"
        data-num="${p.number}" data-title="${escapeHtml(p.title)}"
        title="Approve with comment">${ICON_APPROVE}</button>
      <button class="action-btn open-review"
        data-action="review" data-url="${filesUrl}"
        title="Open for review (files tab)">${ICON_EYE}</button>
      <button class="action-btn close-pr"
        data-action="close" data-repo="${escapeHtml(p.repo)}"
        data-num="${p.number}" data-title="${escapeHtml(p.title)}"
        title="Close PR">${ICON_CLOSE}</button>
      <button class="action-btn delete-branch"
        data-action="delete-branch" data-repo="${escapeHtml(p.repo)}"
        data-num="${p.number}" data-title="${escapeHtml(p.title)}"
        title="Close PR and delete branch">${ICON_TRASH}</button>
    </div>`;
}

function makePrCard(p) {
  const div = document.createElement("div");
  div.className = "pr-card";
  div.dataset.prUrl = p.url;
  div.innerHTML = prCardHtml(p);
  div._snap = p;
  return div;
}

function syncPrCard(div, p) {
  const s = div._snap;
  if (
    s &&
    s.title === p.title &&
    s.review_status === p.review_status &&
    s.created_at === p.created_at &&
    s.updated_at === p.updated_at
  )
    return;
  div.innerHTML = prCardHtml(p);
  div._snap = p;
}

// Keyed reconciliation shared by the table body and the card grid: moves,
// updates, or inserts children by PR URL without wiping unaffected ones.
function reconcileKeyed(container, list, makeFn, syncFn) {
  const old = new Map(
    Array.from(container.children)
      .filter((node) => node.dataset.prUrl)
      .map((node) => [node.dataset.prUrl, node])
  );
  const seen = new Set();

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    let node = old.get(p.url);
    if (node) {
      syncFn(node, p);
      seen.add(p.url);
    } else {
      node = makeFn(p);
    }
    const atI = container.children[i];
    if (atI !== node) container.insertBefore(node, atI || null);
  }

  for (const [url, node] of old) {
    if (!seen.has(url)) node.remove();
  }
}

function renderTable() {
  const list = sortedFilteredPrs();

  // Summary bar — scoped to the current selection (not needsAttention/search,
  // which only narrow the table below), so it never reports stale totals for
  // members that have since been deselected.
  const selected = selectedLogins();
  const scoped = prs.filter((p) => selected.has(p.author.toLowerCase()));
  const awaiting = scoped.filter((p) => p.review_status === "awaiting").length;
  const changes = scoped.filter((p) => p.review_status === "changes_requested").length;
  const approved = scoped.filter((p) => p.review_status === "approved").length;
  const trackedCount = effectiveLogins().length;
  if (trackedCount && filterSelection.size > 0) {
    const parts = [`${scoped.length} open PR${scoped.length === 1 ? "" : "s"}`];
    if (awaiting) parts.push(`${awaiting} awaiting`);
    if (changes) parts.push(`${changes} changes requested`);
    if (approved) parts.push(`${approved} approved`);
    summary.textContent = parts.join(" · ");
  } else {
    summary.textContent = "";
  }

  // Empty-state messaging (don't return early — fall through to reconcile).
  if (trackedCount === 0) {
    emptyState.classList.remove("hidden");
    emptyState.textContent =
      "Add users or groups in Settings to see their open pull requests.";
  } else if (filterSelection.size === 0) {
    emptyState.classList.remove("hidden");
    emptyState.textContent =
      "Select users or groups in the sidebar, then click Fetch to load their pull requests.";
  } else if (list.length === 0) {
    emptyState.classList.remove("hidden");
    emptyState.textContent = prs.length
      ? "No pull requests match the current filter."
      : "No open pull requests found for these members. 🎉";
  } else {
    emptyState.classList.add("hidden");
  }

  // Keep both the table body and the card grid reconciled regardless of
  // which one is currently visible, so switching views is instant.
  reconcileKeyed(prBody, list, makePrRow, syncPrRow);
  reconcileKeyed(cardGrid, list, makePrCard, syncPrCard);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

// Shown only while there's nothing on screen yet to reconcile against —
// i.e. the very first fetch, or any refresh starting from an empty table.
// Subsequent refreshes keep showing the existing rows (see renderTable()'s
// incremental reconciliation) rather than blanking out to a spinner.
function setLoading(flag) {
  loadingOverlay.classList.toggle("hidden", !flag);
  if (flag) {
    listView.classList.add("hidden");
    cardView.classList.add("hidden");
    emptyState.classList.add("hidden");
  }
}

async function fetchPrs() {
  const logins = resolvedSelectedLogins();
  if (logins.length === 0) {
    prs = [];
    lastRateLimit = null;
    updateSearchUsageMeter(null);
    updateCoreUsageMeter(null);
    if (effectiveLogins().length > 0) {
      showBanner("Select at least one user or group, then click Fetch.", "info");
    }
    renderTable();
    renderSidebarFilter();
    return;
  }
  const showingLoader = prs.length === 0;
  if (showingLoader) setLoading(true);
  fetchBtn.disabled = true;
  fetchBtn.textContent = "Fetching…";
  clearBanner();
  try {
    const result = await invoke("fetch_prs", { selectedLogins: logins });
    prs = result.prs;
    lastRateLimit = result.rate_limit;
    updateSearchUsageMeter(lastRateLimit);
    updateCoreUsageMeter(lastRateLimit);
    lastRefresh.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    showBanner(String(e));
  } finally {
    if (showingLoader) {
      setLoading(false);
      applyViewMode();
    }
    renderTable();
    renderSidebarFilter();
    fetchBtn.disabled = false;
    fetchBtn.textContent = "Fetch";
  }
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------
function switchSettingsCategory(category) {
  document.querySelectorAll(".settings-nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.category === category);
  });
  document.querySelectorAll(".settings-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.panel !== category);
  });
}

function openSettings() {
  el("base-url").value = window.__cfg?.base_url || "";
  el("token").value = "";
  el("token").placeholder = window.__cfg?.has_token
    ? "•••••••• (leave blank to keep saved token)"
    : "ghp_…";
  el("usage-refresh-secs").value = window.__cfg?.usage_refresh_secs ?? 5;
  switchSettingsCategory("connections");
  el("settings-modal").classList.remove("hidden");
}
function closeSettings() {
  el("settings-modal").classList.add("hidden");
}

async function saveSettings() {
  const base_url = el("base-url").value.trim();
  const token = el("token").value;
  const usageRefreshSecs = parseInt(el("usage-refresh-secs").value, 10);
  if (!base_url) {
    showBanner("Enter your GitHub host.");
    return;
  }
  if (Number.isNaN(usageRefreshSecs) || usageRefreshSecs < 1) {
    showBanner("API usage refresh interval must be at least 1 second.");
    return;
  }
  try {
    window.__cfg = await invoke("save_connection", {
      baseUrl: base_url,
      token,
      usageRefreshSecs,
    });
    usageTickMs = window.__cfg.usage_refresh_secs * 1000;
    scheduleUsageTick();
    closeSettings();
    clearBanner();
  } catch (e) {
    showBanner(String(e));
  }
}

// ---------------------------------------------------------------------------
// Wire up events
// ---------------------------------------------------------------------------
el("add-member-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = el("member-input");
  const val = input.value.trim();
  if (val) {
    addMember(val);
    input.value = "";
  }
});

el("add-group-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = el("group-input");
  const val = input.value.trim();
  if (!val) return;
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await addGroup(val);
    input.value = "";
  } catch (err) {
    showBanner(String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Add group";
  }
});

// Shared by the table body and the card grid — both use the same
// data-action buttons and .pr-title links.
function handlePrContainerClick(e) {
  const link = e.target.closest("a.pr-title");
  if (link) {
    e.preventDefault();
    openExternal(link.dataset.url);
    return;
  }

  const btn = e.target.closest("button.action-btn");
  if (!btn) return;
  const { action, repo, num, title, url } = btn.dataset;
  const prNum = parseInt(num, 10);

  if (action === "approve") {
    openApproveModal(repo, prNum, title);
  } else if (action === "review") {
    openExternal(url);
  } else if (action === "close") {
    openConfirmModal(
      "Close pull request",
      `Close ${repo} #${prNum} — "${title}"? This cannot be undone.`,
      async () => {
        closeConfirmModal();
        try {
          await invoke("close_pr", { ownerRepo: repo, prNumber: prNum });
          showBanner(`Closed PR #${prNum}.`, "info");
          prs = prs.filter((p) => !(p.repo === repo && p.number === prNum));
          renderTable();
        } catch (err) {
          showBanner(String(err));
        }
      }
    );
  } else if (action === "delete-branch") {
    openConfirmModal(
      "Close PR and delete branch",
      `Close ${repo} #${prNum} and delete its head branch? This cannot be undone.`,
      async () => {
        closeConfirmModal();
        try {
          await invoke("close_pr_and_delete_branch", { ownerRepo: repo, prNumber: prNum });
          showBanner(`Closed PR #${prNum} and deleted branch.`, "info");
          prs = prs.filter((p) => !(p.repo === repo && p.number === prNum));
          renderTable();
        } catch (err) {
          showBanner(String(err));
        }
      }
    );
  }
}
prBody.addEventListener("click", handlePrContainerClick);
cardGrid.addEventListener("click", handlePrContainerClick);

function applySidebarVisibility() {
  el("layout").classList.toggle("sidebar-collapsed", !sidebarVisible);
}

function applyViewMode() {
  listView.classList.toggle("hidden", viewMode !== "list");
  cardView.classList.toggle("hidden", viewMode !== "card");
  el("view-list-btn").classList.toggle("active", viewMode === "list");
  el("view-card-btn").classList.toggle("active", viewMode === "card");
}

// "system" resolves live via matchMedia; "light"/"dark" are fixed choices.
function resolveTheme() {
  if (theme === "light" || theme === "dark") return theme;
  return systemThemeMedia && systemThemeMedia.matches ? "dark" : "light";
}

function applyTheme() {
  document.documentElement.setAttribute("data-theme", resolveTheme());
  ["light", "dark", "system"].forEach((choice) => {
    el(`theme-${choice}-btn`).classList.toggle("active", theme === choice);
  });
}

// Wired once at boot: when the OS theme changes and the user's preference is
// "system", follow it live without needing a restart.
function initThemeWatcher() {
  systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  systemThemeMedia.addEventListener("change", () => {
    if (theme === "system") applyTheme();
  });
}

async function saveUiPrefs() {
  try {
    window.__cfg = await invoke("save_ui_prefs", { sidebarVisible, viewMode, theme });
  } catch (e) {
    showBanner(String(e));
  }
}

async function setViewMode(mode) {
  if (viewMode === mode) return;
  viewMode = mode;
  applyViewMode();
  await saveUiPrefs();
}

async function setTheme(next) {
  if (theme === next) return;
  theme = next;
  applyTheme();
  await saveUiPrefs();
}

el("sidebar-toggle-btn").addEventListener("click", async () => {
  sidebarVisible = !sidebarVisible;
  applySidebarVisibility();
  await saveUiPrefs();
});

document.querySelectorAll("button[data-theme-choice]").forEach((btn) => {
  btn.addEventListener("click", () => setTheme(btn.dataset.themeChoice));
});

el("view-list-btn").addEventListener("click", () => setViewMode("list"));
el("view-card-btn").addEventListener("click", () => setViewMode("card"));

document.querySelectorAll(".settings-nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchSettingsCategory(btn.dataset.category));
});

el("fetch-btn").addEventListener("click", fetchPrs);
el("help-btn").addEventListener("click", () => {
  const menu = el("help-menu");
  menu.classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#help-btn") && !e.target.closest("#help-menu")) {
    closeHelpMenu();
  }
});
document.querySelectorAll(".help-menu-item").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const action = btn.dataset.helpAction;
    if (action === "open-help") {
      await openHelpPage();
    } else if (action === "version") {
      await openVersionDialog();
    } else if (action === "github") {
      await openGitHubRepo();
    } else if (action === "report-issue") {
      await openReportIssue();
    }
  });
});
el("version-close").addEventListener("click", closeVersionDialog);
el("version-modal").addEventListener("click", (e) => {
  if (e.target.id === "version-modal") closeVersionDialog();
});
el("first-run-close").addEventListener("click", async () => {
  closeFirstRunDialog();
  await markFirstRunSeen();
});
el("first-run-open-help").addEventListener("click", async () => {
  closeFirstRunDialog();
  await markFirstRunSeen();
  await openHelpPage();
});
el("first-run-modal").addEventListener("click", async (e) => {
  if (e.target.id === "first-run-modal") {
    closeFirstRunDialog();
    await markFirstRunSeen();
  }
});
el("settings-btn").addEventListener("click", openSettings);
el("settings-cancel").addEventListener("click", closeSettings);
el("settings-save").addEventListener("click", saveSettings);
el("settings-modal").addEventListener("click", (e) => {
  if (e.target.id === "settings-modal") closeSettings();
});

el("approve-cancel").addEventListener("click", closeApproveModal);
el("approve-submit").addEventListener("click", submitApprove);
el("approve-modal").addEventListener("click", (e) => {
  if (e.target.id === "approve-modal") closeApproveModal();
});
el("approve-comment").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitApprove();
});

el("export-btn").addEventListener("click", openExportModal);
el("export-cancel").addEventListener("click", closeExportModal);
el("export-csv").addEventListener("click", () => exportReport("csv"));
el("export-html").addEventListener("click", () => exportReport("html"));
el("export-modal").addEventListener("click", (e) => {
  if (e.target.id === "export-modal") closeExportModal();
});

el("confirm-cancel").addEventListener("click", closeConfirmModal);
el("confirm-ok").addEventListener("click", () => pendingConfirm && pendingConfirm());
el("confirm-modal").addEventListener("click", (e) => {
  if (e.target.id === "confirm-modal") closeConfirmModal();
});

el("filter-awaiting").addEventListener("change", (e) => {
  needsAttentionOnly = e.target.checked;
  renderTable();
});
el("search-box").addEventListener("input", (e) => {
  searchText = e.target.value.trim();
  renderTable();
});

document.querySelectorAll(".pr-table th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = "asc";
    }
    document.querySelectorAll(".pr-table th").forEach((h) => {
      h.classList.remove("sorted-asc", "sorted-desc");
    });
    th.classList.add(sortDir === "asc" ? "sorted-asc" : "sorted-desc");
    renderTable();
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  try {
    window.__cfg = await invoke("get_settings");
    members = window.__cfg.members || [];
    groups = window.__cfg.groups || [];
    sidebarVisible = window.__cfg.sidebar_visible ?? true;
    viewMode = window.__cfg.view_mode || "list";
    theme = window.__cfg.theme || "system";
    usageTickMs = (window.__cfg.usage_refresh_secs ?? 5) * 1000;
    applySidebarVisibility();
    applyViewMode();
    applyTheme();
    renderTeamSettingsLists();
    renderSidebarFilter();
    updateSearchUsageMeter(null);
    updateCoreUsageMeter(null);
    renderTable();
    scheduleUsageTick();

    if (window.__cfg.first_run !== false) {
      openFirstRunDialog();
    }

    if (!window.__cfg.base_url || !window.__cfg.has_token) {
      openSettings();
    }
  } catch (e) {
    showBanner("Failed to start: " + String(e));
  }
}

// Apply a theme immediately (before settings load) to avoid a flash of the
// wrong theme on boot; init() re-applies once the persisted choice is known.
initThemeWatcher();
applyTheme();

init();
