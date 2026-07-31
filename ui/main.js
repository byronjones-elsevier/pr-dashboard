const { invoke } = window.__TAURI__.core;

// Open external links (PR pages) in the user's default browser via the
// opener plugin — a Tauri webview won't do this for a normal <a> click.
function openExternal(url) {
  invoke("plugin:opener|open_url", { url }).catch((e) => showBanner(String(e)));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let members = [];
let prs = [];
let sortKey = "created_at";
let sortDir = "asc"; // asc = oldest first
let needsAttentionOnly = false;
let searchText = "";

const STALE_DAYS = 7;
const VERY_STALE_DAYS = 21;
const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const memberList = el("member-list");
const memberEmpty = el("member-empty");
const prBody = el("pr-body");
const emptyState = el("empty-state");
const banner = el("status-banner");
const summary = el("summary");
const lastRefresh = el("last-refresh");
const refreshBtn = el("refresh-btn");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
function prCountFor(login) {
  return prs.filter((p) => p.author.toLowerCase() === login.toLowerCase())
    .length;
}

function renderMembers() {
  memberList.innerHTML = "";
  memberEmpty.classList.toggle("hidden", members.length > 0);
  for (const m of members) {
    const li = document.createElement("li");
    const count = prCountFor(m);
    li.innerHTML = `
      <span class="name">${escapeHtml(m)}</span>
      <span class="count">${count} PR${count === 1 ? "" : "s"}</span>
      <button class="remove-x" title="Remove ${escapeHtml(m)}">✕</button>`;
    li.querySelector(".remove-x").addEventListener("click", () =>
      removeMember(m)
    );
    memberList.appendChild(li);
  }
}

async function addMember(login) {
  try {
    members = await invoke("add_member", { login });
    renderMembers();
    await refresh();
  } catch (e) {
    showBanner(String(e));
  }
}

async function removeMember(login) {
  try {
    members = await invoke("remove_member", { login });
    prs = prs.filter((p) => p.author.toLowerCase() !== login.toLowerCase());
    renderMembers();
    renderTable();
  } catch (e) {
    showBanner(String(e));
  }
}

// ---------------------------------------------------------------------------
// PR table
// ---------------------------------------------------------------------------
function sortedFilteredPrs() {
  let list = prs.slice();

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

function renderTable() {
  const list = sortedFilteredPrs();
  prBody.innerHTML = "";

  const awaiting = prs.filter((p) => p.review_status === "awaiting").length;
  const changes = prs.filter(
    (p) => p.review_status === "changes_requested"
  ).length;
  const approved = prs.filter((p) => p.review_status === "approved").length;

  if (members.length) {
    const parts = [`${prs.length} open PR${prs.length === 1 ? "" : "s"}`];
    if (awaiting) parts.push(`${awaiting} awaiting`);
    if (changes) parts.push(`${changes} changes requested`);
    if (approved) parts.push(`${approved} approved`);
    summary.textContent = parts.join(" · ");
  } else {
    summary.textContent = "";
  }

  if (members.length === 0) {
    emptyState.classList.remove("hidden");
    emptyState.textContent =
      "Add team members in the sidebar to see their open pull requests.";
    return;
  }
  if (list.length === 0) {
    emptyState.classList.remove("hidden");
    emptyState.textContent = prs.length
      ? "No pull requests match the current filter."
      : "No open pull requests found for these members. 🎉";
    return;
  }
  emptyState.classList.add("hidden");

  for (const p of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <a class="pr-title" href="${escapeHtml(p.url)}" data-url="${escapeHtml(p.url)}">${escapeHtml(p.title)}</a>
        <span class="pr-num">#${p.number}</span>
      </td>
      <td class="repo-cell">${escapeHtml(p.repo)}</td>
      <td>${escapeHtml(p.author)}</td>
      <td>${reviewBadge(p.review_status)}</td>
      <td class="age ${ageClass(p.created_at)}">${humanAge(p.created_at)}</td>
      <td class="age ${ageClass(p.updated_at)}">${humanAge(p.updated_at)}</td>`;
    prBody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------
async function refresh() {
  if (members.length === 0) {
    prs = [];
    renderTable();
    renderMembers();
    return;
  }
  refreshBtn.disabled = true;
  refreshBtn.textContent = "Loading…";
  clearBanner();
  try {
    prs = await invoke("fetch_prs");
    lastRefresh.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    renderTable();
    renderMembers();
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
  el("settings-modal").classList.remove("hidden");
}
function closeSettings() {
  el("settings-modal").classList.add("hidden");
}

async function saveSettings() {
  const base_url = el("base-url").value.trim();
  const token = el("token").value;
  if (!base_url) {
    showBanner("Enter your GitHub host.");
    return;
  }
  try {
    window.__cfg = await invoke("save_connection", { baseUrl: base_url, token });
    closeSettings();
    clearBanner();
    await refresh();
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

el("import-team-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = el("team-input");
  const val = input.value.trim();
  if (!val) return;
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    members = await invoke("import_team", { teamSlug: val });
    input.value = "";
    renderMembers();
    await refresh();
  } catch (err) {
    showBanner(String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Import";
  }
});

prBody.addEventListener("click", (e) => {
  const link = e.target.closest("a.pr-title");
  if (link) {
    e.preventDefault();
    openExternal(link.dataset.url);
  }
});

el("refresh-btn").addEventListener("click", refresh);
el("settings-btn").addEventListener("click", openSettings);
el("settings-cancel").addEventListener("click", closeSettings);
el("settings-save").addEventListener("click", saveSettings);
el("settings-modal").addEventListener("click", (e) => {
  if (e.target.id === "settings-modal") closeSettings();
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
    renderMembers();
    renderTable();
    if (!window.__cfg.base_url || !window.__cfg.has_token) {
      openSettings();
    } else {
      await refresh();
      // Auto-refresh every 5 minutes; skip if a manual refresh is in progress.
      setInterval(() => {
        if (!refreshBtn.disabled) refresh();
      }, AUTO_REFRESH_MS);
    }
  } catch (e) {
    showBanner("Failed to start: " + String(e));
  }
}

init();
