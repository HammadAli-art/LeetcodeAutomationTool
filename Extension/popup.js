console.log("LeetCode GitHub Sync: popup loaded.");

const tokenInput = document.getElementById("token");
const repoInput = document.getElementById("repo");
const saveBtn = document.getElementById("saveBtn");
const statusDiv = document.getElementById("status");
const lastSyncDiv = document.getElementById("lastSync");

// Load any previously saved settings when the popup opens.
chrome.storage.local.get(["githubToken", "githubRepo"], (result) => {
  if (result.githubToken) tokenInput.value = result.githubToken;
  if (result.githubRepo) repoInput.value = result.githubRepo;
});

// Show what happened on the most recent submission sync, so the user isn't
// guessing whether it worked without opening DevTools. Also clear the icon
// badge now that they've actually seen the result.
chrome.storage.local.get(["lastSync"], (result) => {
  const s = result.lastSync;
  if (!s) {
    lastSyncDiv.innerHTML = `<div class="label">Last Sync</div><div>No submissions synced yet.</div>`;
    return;
  }
  const icon = s.ok ? "✅" : "❌";
  const color = s.ok ? "#2ea44f" : "#d73a49";
  const when = new Date(s.timestamp).toLocaleString();
  lastSyncDiv.innerHTML = `
    <div class="label">Last Sync</div>
    <div style="color:${color}">${icon} <span class="title">${s.title || ""}</span></div>
    <div>${s.message || ""}</div>
    <div class="time">${when}</div>
  `;
});

// Full history list (newest first), hidden by default to keep the popup
// compact — the user expands it only when they actually want to look back.
const toggleHistoryBtn = document.getElementById("toggleHistory");
const historyListDiv = document.getElementById("historyList");
let historyLoaded = false;

toggleHistoryBtn.addEventListener("click", () => {
  const isHidden = historyListDiv.style.display === "none";
  historyListDiv.style.display = isHidden ? "block" : "none";
  toggleHistoryBtn.textContent = isHidden ? "Hide recent history" : "Show recent history";

  if (isHidden && !historyLoaded) {
    historyLoaded = true;
    chrome.storage.local.get(["syncHistory"], (result) => {
      const history = result.syncHistory || [];
      if (!history.length) {
        historyListDiv.innerHTML = `<div class="history-item">No history yet.</div>`;
        return;
      }
      historyListDiv.innerHTML = history
        .map((h) => {
          const icon = h.ok ? "✅" : "❌";
          const when = new Date(h.timestamp).toLocaleString();
          return `
            <div class="history-item">
              ${icon} <span class="title">${h.title || ""}</span>
              <div>${h.message || ""}</div>
              <div class="time">${when}</div>
            </div>
          `;
        })
        .join("");
    });
  }
});

try {
  chrome.action.setBadgeText({ text: "" });
} catch (e) {
  // Non-fatal — badge is a nice-to-have.
}

function setStatus(text, color) {
  statusDiv.style.color = color;
  statusDiv.textContent = text;
}

// Basic "owner/repo" shape check before we even hit the network.
function parseRepo(githubRepo) {
  const parts = githubRepo.split("/").map((p) => p.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

// Confirms the token is valid AND has write access to this specific repo,
// so the user finds out about problems now instead of on their next Accepted
// submission (when there's no UI to show them the error).
async function validateGithubAccess(owner, repo, token) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (response.status === 401) {
    return { ok: false, message: "Invalid or expired GitHub token." };
  }
  if (response.status === 404) {
    return { ok: false, message: "Repository not found (check the name, or token needs access to it)." };
  }
  if (!response.ok) {
    return { ok: false, message: `GitHub check failed (${response.status}).` };
  }

  const data = await response.json();
  if (data.permissions && !data.permissions.push) {
    return { ok: false, message: "Token doesn't have write access to this repo." };
  }
  return { ok: true };
}

saveBtn.addEventListener("click", async () => {
  const githubToken = tokenInput.value.trim();
  const githubRepo = repoInput.value.trim();

  if (!githubToken || !githubRepo) {
    setStatus("Please fill in both fields.", "red");
    return;
  }

  const parsed = parseRepo(githubRepo);
  if (!parsed) {
    setStatus('Repo must be in "owner/repo-name" format.', "red");
    return;
  }

  saveBtn.disabled = true;
  setStatus("Checking token and repo access...", "#555");

  try {
    const result = await validateGithubAccess(parsed.owner, parsed.repo, githubToken);
    if (!result.ok) {
      setStatus(result.message, "red");
      return;
    }

    chrome.storage.local.set({ githubToken, githubRepo }, () => {
      setStatus("Saved! GitHub connection verified.", "green");
    });
  } catch (err) {
    console.error("Validation request failed:", err);
    setStatus("Network error while checking GitHub — try again.", "red");
  } finally {
    saveBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Full History Import
// ---------------------------------------------------------------------------

const importBtn = document.getElementById("importBtn");
const importProgressWrap = document.getElementById("importProgressWrap");
const importProgressBarFill = document.querySelector("#importProgressBar > div");
const importStatusText = document.getElementById("importStatusText");

// We don't know the total problem count up front (LeetCode's submissionList
// doesn't expose it cheaply), so the bar shows real progress relative to
// what's been processed so far, growing toward — but never quite reaching —
// 100% while running, then snapping to 100% only once actually complete.
// This is honest about not knowing the total, while still giving visual
// feedback that something is happening.
function renderImportState(state) {
  if (!state || state.status === "idle") {
    importBtn.textContent = "Import All Past Submissions";
    importBtn.classList.remove("cancel");
    importProgressWrap.style.display = "none";
    return;
  }

  const total = state.imported + state.failed;

  if (state.status === "running") {
    importBtn.textContent = "Cancel Import";
    importBtn.classList.add("cancel");
    importProgressWrap.style.display = "block";
    const pct = Math.min(95, 10 + total * 2); // asymptotic — never claims false completion
    importProgressBarFill.style.width = `${pct}%`;
    importStatusText.textContent = state.currentTitle
      ? `Importing "${state.currentTitle}"… (${state.imported} done, ${state.failed} failed)`
      : `Starting… (${state.imported} done, ${state.failed} failed)`;
    return;
  }

  importBtn.textContent = "Import All Past Submissions";
  importBtn.classList.remove("cancel");
  importProgressWrap.style.display = "block";

  if (state.status === "completed") {
    importProgressBarFill.style.width = "100%";
    importStatusText.textContent = `Done — ${state.imported} imported, ${state.failed} failed.`;
  } else if (state.status === "paused") {
    importProgressBarFill.style.width = `${Math.min(95, 10 + total * 2)}%`;
    importStatusText.textContent = `Paused — ${state.imported} imported so far. Click to resume.`;
  } else if (state.status === "error") {
    importProgressBarFill.style.width = `${Math.min(95, 10 + total * 2)}%`;
    importStatusText.textContent = `Stopped: ${state.lastError || "unknown error"}. Click to resume.`;
  }
}

// Reflect the current state as soon as the popup opens — the import may
// have been started from a previous popup session and still be running.
chrome.runtime.sendMessage({ type: "GET_HISTORY_IMPORT_STATE" }, renderImportState);

// Live updates while this popup instance stays open.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "HISTORY_IMPORT_PROGRESS") {
    renderImportState(message.state);
  }
});

importBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "GET_HISTORY_IMPORT_STATE" }, (state) => {
    if (state && state.status === "running") {
      chrome.runtime.sendMessage({ type: "CANCEL_HISTORY_IMPORT" });
    } else {
      chrome.storage.local.get(["githubToken", "githubRepo"], (result) => {
        if (!result.githubToken || !result.githubRepo) {
          setStatus("Save your GitHub token + repo above before importing.", "red");
          return;
        }
        chrome.runtime.sendMessage({ type: "START_HISTORY_IMPORT" });
        importBtn.textContent = "Cancel Import";
        importBtn.classList.add("cancel");
        importProgressWrap.style.display = "block";
        importStatusText.textContent = "Starting…";
      });
    }
  });
});