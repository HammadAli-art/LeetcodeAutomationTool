console.log("Kodelith: popup loaded.");

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
    lastSyncDiv.innerHTML = `<div class="label">🕒 Last Sync</div><div>No submissions synced yet.</div>`;
    return;
  }
  const icon = s.ok ? "✅" : "❌";
  const color = s.ok ? "#2ea44f" : "#d73a49";
  const when = new Date(s.timestamp).toLocaleString();
  lastSyncDiv.innerHTML = `
    <div class="label">🕒 Last Sync</div>
    <div style="color:${color}">${icon} <span class="title">${s.title || ""}</span></div>
    <div>${s.message || ""}</div>
    <div class="time">${when}</div>
  `;
});

// "Today's Problems" — only successful syncs (solve or resubmit) that
// happened on today's LOCAL date. This list is naturally short (it only
// grows during the current day) and resets itself once the date rolls over,
// without needing any separate cleanup logic.
const todaysBtn = document.getElementById("todaysProblemsBtn");
const todaysListDiv = document.getElementById("todaysProblemsList");

function isSameLocalDay(isoTimestamp, reference) {
  const d = new Date(isoTimestamp);
  return (
    d.getFullYear() === reference.getFullYear() &&
    d.getMonth() === reference.getMonth() &&
    d.getDate() === reference.getDate()
  );
}

todaysBtn.addEventListener("click", () => {
  const isHidden = todaysListDiv.style.display === "none";
  todaysListDiv.style.display = isHidden ? "block" : "none";
  todaysBtn.textContent = isHidden ? "📅 Hide Today's Problems" : "📅 Today's Problems";

  if (!isHidden) return;

  // Recomputed every time it's opened (not cached) — cheap, and correctly
  // handles the popup being left open across midnight.
  chrome.storage.local.get(["syncHistory"], (result) => {
    const history = result.syncHistory || [];
    const now = new Date();
    const todays = history.filter((h) => h.ok && isSameLocalDay(h.timestamp, now));

    if (!todays.length) {
      todaysListDiv.innerHTML = `<div class="history-item">No problems solved yet.</div>`;
      return;
    }

    todaysListDiv.innerHTML = todays
      .map((h) => {
        const when = new Date(h.timestamp).toLocaleTimeString();
        return `
          <div class="history-item">
            <span class="title">${h.title || ""}</span>
            <div class="time">${when}</div>
          </div>
        `;
      })
      .join("");
  });
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

// Fetches up to 100 of the user's most recently updated repos. Only fetches
// one page — a deliberate scope limit for now, so users with 100+ repos may
// not see everything here and can still type the repo name manually.
async function fetchUserRepos(token) {
  const response = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  return response.json();
}

const loadReposBtn = document.getElementById("loadReposBtn");
const repoPicker = document.getElementById("repoPicker");

loadReposBtn.addEventListener("click", async () => {
  let token = tokenInput.value.trim();
  if (!token) {
    const stored = await chrome.storage.local.get(["githubToken"]);
    token = stored.githubToken || "";
  }
  if (!token) {
    setStatus("Connect with GitHub above, or paste a token manually, first.", "red");
    return;
  }

  loadReposBtn.disabled = true;
  loadReposBtn.textContent = "Loading...";

  try {
    const repos = await fetchUserRepos(token);
    if (!repos.length) {
      setStatus("No repos found for this token.", "red");
      return;
    }

    repoPicker.innerHTML =
      `<option value="">— Select a repo —</option>` +
      repos.map((r) => `<option value="${r.full_name}">${r.full_name}${r.private ? " 🔒" : ""}</option>`).join("");
    repoPicker.style.display = "block";
    setStatus(`Loaded ${repos.length} repos (most recently updated).`, "#555");
  } catch (err) {
    console.error("Failed to load repos:", err);
    setStatus("Couldn't load repos — check your token.", "red");
  } finally {
    loadReposBtn.disabled = false;
    loadReposBtn.textContent = "Load My Repos";
  }
});

repoPicker.addEventListener("change", () => {
  if (repoPicker.value) repoInput.value = repoPicker.value;
});

saveBtn.addEventListener("click", async () => {
  const manualToken = tokenInput.value.trim();
  const githubRepo = repoInput.value.trim();

  // Manual field left blank -> keep whatever token is already saved (most
  // commonly one obtained via "Connect with GitHub"). Filling it in
  // deliberately overrides that, for advanced/manual use.
  const { githubToken: existingToken } = await chrome.storage.local.get(["githubToken"]);
  const githubToken = manualToken || existingToken;

  if (!githubToken) {
    setStatus("Connect with GitHub above, or paste a token manually.", "red");
    return;
  }
  if (!githubRepo) {
    setStatus("Please enter a repo.", "red");
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
      return;
    }

    if (state && state.status === "completed") {
      importStatusText.innerHTML =
        `History already imported (${state.imported} problems). ` +
        `<a href="#" id="restartImportLink">Start fresh import</a>`;
      const restartLink = document.getElementById("restartImportLink");
      restartLink.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: "RESET_HISTORY_IMPORT" }, () => {
          chrome.runtime.sendMessage({ type: "START_HISTORY_IMPORT" });
          importBtn.textContent = "Cancel Import";
          importBtn.classList.add("cancel");
          importStatusText.textContent = "Starting…";
        });
      });
      return;
    }

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
  });
});

// ---------------------------------------------------------------------------
// Google Sheets ON/OFF toggle
// ---------------------------------------------------------------------------
// Off by default. Nothing is sent to Google until the user explicitly turns
// this on — matching the same "user's choice, not automatic" philosophy
// requested for this feature.

const sheetsBtn = document.getElementById("sheetsBtn");
const sheetsStatusText = document.getElementById("sheetsStatusText");
const sheetsBackfillPrompt = document.getElementById("sheetsBackfillPrompt");
const sheetsBackfillMessage = document.getElementById("sheetsBackfillMessage");
const sheetsBackfillYesBtn = document.getElementById("sheetsBackfillYesBtn");
const sheetsBackfillNoBtn = document.getElementById("sheetsBackfillNoBtn");
const sheetsBackfillProgressWrap = document.getElementById("sheetsBackfillProgressWrap");
const sheetsBackfillProgressBarFill = document.querySelector("#sheetsBackfillProgressBar > div");
const sheetsBackfillStatusText = document.getElementById("sheetsBackfillStatusText");

function renderSheetsState(state) {
  if (!state || !state.enabled) {
    sheetsBtn.textContent = "Turn On Google Sheets Sync";
    sheetsBtn.classList.remove("on");
    sheetsStatusText.innerHTML = state?.connected
      ? "Off. (Previously connected — turning on reuses your existing sheet.)"
      : "Off.";
    return;
  }
  sheetsBtn.textContent = "Turn Off Google Sheets Sync";
  sheetsBtn.classList.add("on");
  sheetsStatusText.innerHTML = state.url
    ? `On — <a href="${state.url}" target="_blank">open your sheet</a>`
    : "On.";
}

chrome.runtime.sendMessage({ type: "GET_SHEETS_STATE" }, renderSheetsState);

sheetsBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "GET_SHEETS_STATE" }, (state) => {
    const turningOn = !(state && state.enabled);

    sheetsBtn.disabled = true;
    sheetsStatusText.textContent = turningOn ? "Connecting to Google…" : "Turning off…";

    chrome.runtime.sendMessage({ type: "TOGGLE_GOOGLE_SHEETS", enable: turningOn }, (result) => {
      sheetsBtn.disabled = false;
      if (turningOn && result && result.ok === false) {
        sheetsStatusText.textContent = `Couldn't connect: ${result.message || "unknown error"}`;
        return;
      }
      chrome.runtime.sendMessage({ type: "GET_SHEETS_STATE" }, renderSheetsState);

      // Only offer the backfill when turning ON, and only if there's an
      // actual gap — problems already on GitHub from before this connection
      // (or from while Sheets sync was off) that never made it into the sheet.
      if (turningOn && result && result.backfillCount > 0) {
        sheetsBackfillMessage.textContent =
          `${result.backfillCount} problem${result.backfillCount === 1 ? "" : "s"} already on GitHub ` +
          `${result.backfillCount === 1 ? "wasn't" : "weren't"} added to your sheet. Add ${result.backfillCount === 1 ? "it" : "them"} now?`;
        sheetsBackfillPrompt.style.display = "block";
      }
    });
  });
});

sheetsBackfillNoBtn.addEventListener("click", () => {
  sheetsBackfillPrompt.style.display = "none";
});

sheetsBackfillYesBtn.addEventListener("click", () => {
  sheetsBackfillPrompt.style.display = "none";
  sheetsBackfillProgressWrap.style.display = "block";
  sheetsBackfillStatusText.textContent = "Starting…";
  chrome.runtime.sendMessage({ type: "START_SHEETS_BACKFILL" });
});

function renderSheetsBackfillState(state) {
  if (!state || state.status === "idle") {
    sheetsBackfillProgressWrap.style.display = "none";
    return;
  }

  sheetsBackfillProgressWrap.style.display = "block";
  const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
  sheetsBackfillProgressBarFill.style.width = `${pct}%`;

  if (state.status === "running") {
    sheetsBackfillStatusText.textContent = state.currentTitle
      ? `Adding "${state.currentTitle}"… (${state.done}/${state.total})`
      : `Starting… (${state.done}/${state.total})`;
  } else if (state.status === "completed") {
    sheetsBackfillStatusText.textContent =
      `Done — ${state.imported} added${state.skipped ? `, ${state.skipped} couldn't be matched` : ""}.`;
  } else if (state.status === "paused") {
    sheetsBackfillStatusText.textContent = `Paused — ${state.done}/${state.total} processed.`;
  } else if (state.status === "error") {
    sheetsBackfillStatusText.textContent = `Stopped: ${state.lastError || "unknown error"}.`;
  }
}

// Restore progress if a backfill was left running when the popup closed.
chrome.runtime.sendMessage({ type: "GET_SHEETS_BACKFILL_STATE" }, renderSheetsBackfillState);

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SHEETS_BACKFILL_PROGRESS") {
    renderSheetsBackfillState(message.state);
  }
});

// ---------------------------------------------------------------------------
// GitHub Connect (Device Flow)
// ---------------------------------------------------------------------------

const githubConnectBtn = document.getElementById("githubConnectBtn");
const githubConnectBtnLabel = githubConnectBtn.querySelector("span");
const githubConnectStatus = document.getElementById("githubConnectStatus");
const deviceCodeBox = document.getElementById("deviceCodeBox");
const deviceCodeText = document.getElementById("deviceCodeText");
const copyDeviceCodeBtn = document.getElementById("copyDeviceCodeBtn");
const deviceVerifyLink = document.getElementById("deviceVerifyLink");
const deviceFlowStatusText = document.getElementById("deviceFlowStatusText");
const cancelDeviceFlowBtn = document.getElementById("cancelDeviceFlowBtn");

function renderGithubConnectionState(state) {
  deviceCodeBox.style.display = "none";
  githubConnectBtn.disabled = false;

  if (state && state.connected) {
    githubConnectBtnLabel.textContent = "Disconnect GitHub";
    githubConnectBtn.classList.add("on");
    githubConnectStatus.textContent = state.username
      ? `✅ Connected as ${state.username}`
      : "✅ Connected.";
  } else {
    githubConnectBtnLabel.textContent = "Connect with GitHub";
    githubConnectBtn.classList.remove("on");
    githubConnectStatus.textContent = "Not connected.";
  }
}

function showDeviceCodeBox(user_code, verification_uri) {
  githubConnectStatus.textContent = "";
  deviceCodeBox.style.display = "block";
  deviceCodeText.textContent = user_code;
  deviceVerifyLink.href = verification_uri;
  deviceVerifyLink.textContent = `Open ${verification_uri.replace(/^https?:\/\//, "")}`;
  deviceFlowStatusText.textContent = "Waiting for you to authorize on GitHub…";
  githubConnectBtn.disabled = true;
}

chrome.runtime.sendMessage({ type: "GET_GITHUB_CONNECTION_STATE" }, renderGithubConnectionState);

// If a Device Flow was left mid-authorization (e.g. the user opened the
// verification link in a new tab, which closes this popup) and hasn't
// resolved yet, restore the code box on reopen instead of just showing
// "Not connected" and confusing them.
chrome.runtime.sendMessage({ type: "GET_GITHUB_DEVICE_FLOW_STATE" }, (state) => {
  if (state && state.status === "pending") {
    showDeviceCodeBox(state.user_code, state.verification_uri);
  }
});

githubConnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "GET_GITHUB_CONNECTION_STATE" }, (state) => {
    if (state && state.connected) {
      chrome.runtime.sendMessage({ type: "DISCONNECT_GITHUB" }, () => {
        renderGithubConnectionState({ connected: false });
      });
      return;
    }

    githubConnectBtn.disabled = true;
    githubConnectStatus.textContent = "Starting…";
    chrome.runtime.sendMessage({ type: "START_GITHUB_DEVICE_FLOW" });
  });
});

cancelDeviceFlowBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CANCEL_GITHUB_DEVICE_FLOW" });
  deviceCodeBox.style.display = "none";
  githubConnectBtn.disabled = false;
  githubConnectStatus.textContent = "Cancelled.";
});

copyDeviceCodeBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(deviceCodeText.textContent).then(() => {
    copyDeviceCodeBtn.textContent = "Copied!";
    setTimeout(() => { copyDeviceCodeBtn.textContent = "Copy"; }, 1500);
  }).catch(() => {});
});

// Device Flow progress arrives as runtime messages, since it runs entirely
// in the background service worker (continues even if this popup closes —
// e.g. the user opening the verification link in a new tab).
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "GITHUB_DEVICE_CODE") {
    showDeviceCodeBox(message.user_code, message.verification_uri);
    return;
  }

  if (message.type === "GITHUB_DEVICE_FLOW_RESULT") {
    githubConnectBtn.disabled = false;
    deviceCodeBox.style.display = "none";

    if (message.ok) {
      renderGithubConnectionState({ connected: true, username: message.username });
    } else if (message.cancelled) {
      githubConnectStatus.textContent = "Cancelled.";
    } else {
      githubConnectStatus.textContent = `Connection failed: ${message.message || "unknown error"}`;
    }
  }
});