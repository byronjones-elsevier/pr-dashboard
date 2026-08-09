const { invoke } = window.__TAURI__.core;

// Open external links (PR pages) in the user's default browser via the
// opener plugin — a Tauri webview won't do this for a normal <a> click.
function openExternal(url) {
  invoke("plugin:opener|open_url", { url }).catch((e) => showBanner(String(e)));
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
let autoRefreshMs = 10 * 60 * 1000; // updated from settings on load
let autoRefreshTimer = null;
let sidebarVisible = true;
let viewMode = "list"; // "list" | "card"
// Selected filter keys: "user:<login>" or "group:<slug>" (lowercased).
// Empty = no filter applied (show every tracked PR).
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
const emptyState = el("empty-state");
const banner = el("status-banner");
const summary = el("summary");
const lastRefresh = el("last-refresh");
const refreshBtn = el("refresh-btn");
const rateLimitBadge = el("rate-limit-badge");

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

function updateRateLimitBadge(rl) {
  if (!rl) {
    rateLimitBadge.classList.add("hidden");
    return;
  }
  const { search_remaining, search_limit, search_reset } = rl;
  const needed = effectiveLogins().length * 3;
  const pct = search_limit > 0 ? search_remaining / search_limit : 1;
  const low = search_remaining < Math.max(needed * 2, 6); // < 2 refreshes left
  const critical = search_remaining < needed;             // < 1 refresh left

  let cls = "rate-limit-badge";
  if (critical) cls += " critical";
  else if (low) cls += " low";

  const now = Math.floor(Date.now() / 1000);
  const resetIn = Math.max(0, search_reset - now);
  const resetStr = resetIn > 0 ? ` · resets in ${resetIn}s` : "";
  rateLimitBadge.className = cls;
  rateLimitBadge.textContent = `Search API ${search_remaining}/${search_limit}${resetStr}`;
  rateLimitBadge.title = critical
    ? "Rate limit critical — auto-refresh paused until quota recovers."
    : low
    ? "Rate limit low — auto-refresh may be skipped."
    : "GitHub Search API quota";
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
    await refresh();
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
    await refresh();
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
  await refresh();
}

async function removeGroup(slug) {
  try {
    applyTeamUpdate(await invoke("remove_group", { slug }));
    await refresh();
  } catch (e) {
    showBanner(String(e));
  }
}

// Expands the sidebar filter selection (users + groups) into the set of
// logins it resolves to. Returns null when nothing is selected, meaning
// "no filter" rather than "match nobody".
function selectedLogins() {
  if (filterSelection.size === 0) return null;
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

// ---------------------------------------------------------------------------
// PR table
// ---------------------------------------------------------------------------
function sortedFilteredPrs() {
  let list = prs.slice();

  const logins = selectedLogins();
  if (logins) {
    list = list.filter((p) => logins.has(p.author.toLowerCase()));
  }

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

function renderTable() {
  const list = sortedFilteredPrs();

  // Summary bar
  const awaiting = prs.filter((p) => p.review_status === "awaiting").length;
  const changes = prs.filter((p) => p.review_status === "changes_requested").length;
  const approved = prs.filter((p) => p.review_status === "approved").length;
  const trackedCount = effectiveLogins().length;
  if (trackedCount) {
    const parts = [`${prs.length} open PR${prs.length === 1 ? "" : "s"}`];
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
  } else if (list.length === 0) {
    emptyState.classList.remove("hidden");
    emptyState.textContent = prs.length
      ? "No pull requests match the current filter."
      : "No open pull requests found for these members. 🎉";
  } else {
    emptyState.classList.add("hidden");
  }

  // Keyed reconciliation: move/update/add rows without wiping the table.
  // Rows whose data hasn't changed are left completely untouched.
  const oldRows = new Map(
    Array.from(prBody.rows)
      .filter((tr) => tr.dataset.prUrl)
      .map((tr) => [tr.dataset.prUrl, tr])
  );
  const seen = new Set();

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    let tr = oldRows.get(p.url);
    if (tr) {
      syncPrRow(tr, p);
      seen.add(p.url);
    } else {
      tr = makePrRow(p);
    }
    // Place tr at position i without disturbing other rows unnecessarily.
    const atI = prBody.rows[i];
    if (atI !== tr) prBody.insertBefore(tr, atI || null);
  }

  // Remove rows for PRs that have been closed or filtered out.
  for (const [url, tr] of oldRows) {
    if (!seen.has(url)) tr.remove();
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

// Schedules the next auto-refresh to fire autoRefreshMs after THIS call
// returns — i.e. the countdown only begins once the previous fetch is done.
function scheduleNextRefresh() {
  clearTimeout(autoRefreshTimer);
  autoRefreshTimer = setTimeout(async () => {
    const needed = effectiveLogins().length * 3;
    const rateLimitOk = !lastRateLimit || lastRateLimit.search_remaining >= needed;
    if (!refreshBtn.disabled && effectiveLogins().length > 0 && rateLimitOk) {
      await refresh();
    }
    scheduleNextRefresh();
  }, autoRefreshMs);
}

async function refresh() {
  if (effectiveLogins().length === 0) {
    prs = [];
    renderTable();
    renderSidebarFilter();
    return;
  }
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Loading…";
  clearBanner();
  try {
    const result = await invoke("fetch_prs");
    prs = result.prs;
    lastRateLimit = result.rate_limit;
    updateRateLimitBadge(lastRateLimit);
    lastRefresh.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    renderTable();
    renderSidebarFilter();
  } catch (e) {
    showBanner(String(e));
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Refresh";
  }
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------
function openSettings() {
  el("base-url").value = window.__cfg?.base_url || "";
  el("token").value = "";
  el("token").placeholder = window.__cfg?.has_token
    ? "•••••••• (leave blank to keep saved token)"
    : "ghp_…";
  el("refresh-mins").value = window.__cfg?.refresh_interval_mins ?? 10;
  el("settings-modal").classList.remove("hidden");
}
function closeSettings() {
  el("settings-modal").classList.add("hidden");
}

async function saveSettings() {
  const base_url = el("base-url").value.trim();
  const token = el("token").value;
  const refreshMins = parseInt(el("refresh-mins").value, 10);
  if (!base_url) {
    showBanner("Enter your GitHub host.");
    return;
  }
  if (Number.isNaN(refreshMins) || refreshMins < 1) {
    showBanner("Refresh interval must be at least 1 minute.");
    return;
  }
  try {
    window.__cfg = await invoke("save_connection", {
      baseUrl: base_url,
      token,
      refreshIntervalMins: refreshMins,
    });
    autoRefreshMs = window.__cfg.refresh_interval_mins * 60 * 1000;
    closeSettings();
    clearBanner();
    await refresh();
    scheduleNextRefresh();
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

prBody.addEventListener("click", (e) => {
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
          await refresh();
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
          await refresh();
        } catch (err) {
          showBanner(String(err));
        }
      }
    );
  }
});

function applySidebarVisibility() {
  el("layout").classList.toggle("sidebar-collapsed", !sidebarVisible);
}

el("sidebar-toggle-btn").addEventListener("click", async () => {
  sidebarVisible = !sidebarVisible;
  applySidebarVisibility();
  try {
    window.__cfg = await invoke("save_ui_prefs", { sidebarVisible, viewMode });
  } catch (e) {
    showBanner(String(e));
  }
});

el("refresh-btn").addEventListener("click", refresh);
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
    applySidebarVisibility();
    renderTeamSettingsLists();
    renderSidebarFilter();
    renderTable();
    autoRefreshMs = (window.__cfg.refresh_interval_mins ?? 10) * 60 * 1000;

    if (!window.__cfg.base_url || !window.__cfg.has_token) {
      openSettings();
    } else {
      await refresh();
      scheduleNextRefresh();
    }
  } catch (e) {
    showBanner("Failed to start: " + String(e));
  }
}

init();
