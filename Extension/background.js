// This runs in the background, independent of any specific page.
console.log("Kodelith: background service worker loaded.");

const GRAPHQL_URL = "https://leetcode.com/graphql";

// --- Get the CSRF token LeetCode uses for authenticated requests ---
async function getCsrfToken() {
  const cookie = await chrome.cookies.get({ url: "https://leetcode.com", name: "csrftoken" });
  return cookie ? cookie.value : null;
}

// --- Generic GraphQL request helper (mirrors our Python script's approach) ---
async function graphqlRequest(query, variables) {
  const csrfToken = await getCsrfToken();

  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    credentials: "include", // sends LeetCode's session cookies automatically
    headers: {
      "Content-Type": "application/json",
      "x-csrftoken": csrfToken || "",
      "Referer": "https://leetcode.com",
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();
  if (result.errors) {
    throw new Error("GraphQL error: " + JSON.stringify(result.errors));
  }
  return result.data;
}

// --- Get the actual solved code + language for a submission ---
async function fetchSubmissionCode(submissionId) {
  const query = `
    query submissionDetails($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        code
        lang { name }
      }
    }
  `;
  const data = await graphqlRequest(query, { submissionId });
  return {
    code: data.submissionDetails?.code,
    langName: data.submissionDetails?.lang?.name,
  };
}

// --- Get problem number, difficulty, and topic tags ---
async function fetchQuestionDetails(titleSlug) {
  const query = `
    query questionData($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionFrontendId
        title
        difficulty
        topicTags { name }
      }
    }
  `;
  const data = await graphqlRequest(query, { titleSlug });
  return data.question;
}

// Whoever is actually logged into LeetCode in THIS browser right now — read
// live via the session cookies, every time it's needed. This deliberately
// avoids storing a username anywhere: if the person switches LeetCode
// accounts, the very next submission automatically reflects the new
// account, with no stale saved value and no manual field to update.
async function fetchLoggedInUsername() {
  const query = `
    query getUserStatus {
      userStatus {
        isSignedIn
        username
      }
    }
  `;
  const data = await graphqlRequest(query, {});
  if (!data.userStatus || !data.userStatus.isSignedIn) return null;
  return data.userStatus.username || null;
}

// --- One page of the user's own submission history (newest first) ---
// NOTE: this leans on LeetCode's internal "submissionList" GraphQL field
// (the same one that powers the "All Submissions" tab). It's not a public
// documented API, so if LeetCode changes it, this is the first thing to
// re-check.
async function fetchAcceptedSubmissionsPage(offset, limit) {
  // NOTE: LeetCode removed the "status" argument from submissionList
  // (it used to let us filter to only Accepted submissions server-side).
  // We now fetch the page as-is and filter for "Accepted" ourselves below.
  const query = `
    query submissionList($offset: Int!, $limit: Int!) {
      submissionList(offset: $offset, limit: $limit) {
        hasNext
        submissions {
          id
          titleSlug
          title
          statusDisplay
          lang
          timestamp
        }
      }
    }
  `;
  const data = await graphqlRequest(query, { offset, limit });
  const page = data.submissionList;
  return {
    ...page,
    submissions: page.submissions.filter((s) => s.statusDisplay === "Accepted"),
  };
}

// Shared by BOTH the live "just solved a problem" flow AND the bulk history
// import below, so the two paths can never drift out of sync with each other.
async function handleAcceptedSubmission(submissionId, titleSlug, { updateReadmeAfter = true, updateSheetAfter = true } = {}) {
  try {
    const [{ code, langName }, question] = await Promise.all([
      fetchSubmissionCode(parseInt(submissionId, 10)),
      fetchQuestionDetails(titleSlug),
    ]);

    // --- Validate the GraphQL responses before touching GitHub. ---
    // LeetCode can return "question: null" (e.g. slug not found) or a
    // submissionDetails with no code (e.g. permissions hiccup, stale
    // session). Pushing in either case would create a blank/garbage
    // file or throw deep inside pushToGitHub with a confusing error.
    if (!question || !question.questionFrontendId) {
      const msg = `question data missing/invalid for slug: ${titleSlug}`;
      console.error("Kodelith:", msg, question);
      return { ok: false, message: msg };
    }
    if (!code || typeof code !== "string" || !code.trim()) {
      const msg = `submission code missing/empty for submission: ${submissionId}`;
      console.error("Kodelith:", msg);
      return { ok: false, message: msg };
    }
    if (!langName) {
      const msg = `language missing for submission: ${submissionId}`;
      console.error("Kodelith:", msg);
      return { ok: false, message: msg };
    }

    console.log("--- Fetched data ---");
    console.log("Frontend ID:", question.questionFrontendId);
    console.log("Title:", question.title);
    console.log("Topic tags:", (question.topicTags || []).map((t) => t.name));
    console.log("Language:", langName);

    await pushToGitHub(titleSlug, question, code, langName, { updateReadmeAfter, updateSheetAfter });
    return { ok: true };
  } catch (err) {
    console.error("Failed to process submission:", err);
    await recordSyncStatus({
      ok: false,
      frontendId: null,
      title: titleSlug,
      message: `Failed to fetch submission data: ${err.message || err}`,
    });
    return { ok: false, message: err.message || String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SUBMISSION_ACCEPTED") {
    console.log("Background received an Accepted submission:", message.payload);
    const { submissionId, titleSlug } = message;
    if (!submissionId || !titleSlug) {
      console.error("Missing submissionId/titleSlug in message:", message);
      return;
    }
    handleAcceptedSubmission(submissionId, titleSlug);
    return;
  }

  if (message.type === "START_HISTORY_IMPORT") {
    startHistoryImport(); // fire-and-forget — progress is reported via HISTORY_IMPORT_PROGRESS + storage
    sendResponse({ started: true });
    return;
  }

  if (message.type === "CANCEL_HISTORY_IMPORT") {
    cancelHistoryImport();
    sendResponse({ cancelling: true });
    return;
  }

  if (message.type === "GET_HISTORY_IMPORT_STATE") {
    getHistoryImportState().then(sendResponse);
    return true; // keep the message channel open — sendResponse happens async
  }

  if (message.type === "TOGGLE_GOOGLE_SHEETS") {
    if (message.enable) {
      connectGoogleSheets().then(sendResponse);
    } else {
      disableGoogleSheets().then(() => sendResponse({ ok: true, enabled: false }));
    }
    return true;
  }

  if (message.type === "GET_SHEETS_STATE") {
    chrome.storage.local.get(["sheetsSpreadsheetId", "sheetsEnabled"]).then((r) => {
      sendResponse({
        connected: !!r.sheetsSpreadsheetId,
        enabled: !!r.sheetsEnabled,
        url: r.sheetsSpreadsheetId
          ? `https://docs.google.com/spreadsheets/d/${r.sheetsSpreadsheetId}/edit`
          : null,
      });
    });
    return true;
  }

  if (message.type === "START_SHEETS_BACKFILL") {
    startSheetsBackfill(); // fire-and-forget — progress comes via SHEETS_BACKFILL_PROGRESS + storage
    sendResponse({ started: true });
    return;
  }

  if (message.type === "CANCEL_SHEETS_BACKFILL") {
    cancelSheetsBackfill();
    sendResponse({ cancelling: true });
    return;
  }

  if (message.type === "GET_SHEETS_BACKFILL_STATE") {
    getSheetsBackfillState().then(sendResponse);
    return true;
  }

  if (message.type === "START_GITHUB_DEVICE_FLOW") {
    connectGithubViaDeviceFlow(); // fire-and-forget — progress comes via GITHUB_DEVICE_CODE / GITHUB_DEVICE_FLOW_RESULT
    sendResponse({ started: true });
    return;
  }

  if (message.type === "CANCEL_GITHUB_DEVICE_FLOW") {
    cancelGithubDeviceFlow();
    sendResponse({ cancelling: true });
    return;
  }

  if (message.type === "GET_GITHUB_DEVICE_FLOW_STATE") {
    getGithubDeviceFlowState().then((state) => {
      sendResponse(state);
      // Opportunistic recheck: if the popup is being reopened, there's a
      // decent chance the user just came back from authorizing — check now
      // instead of making them wait for the next 1-minute alarm tick.
      if (state && state.status === "pending") attemptGithubTokenPoll();
    });
    return true;
  }

  if (message.type === "GET_GITHUB_CONNECTION_STATE") {
    chrome.storage.local.get(["githubToken", "githubUsername", "githubAuthMethod"]).then((r) => {
      sendResponse({
        connected: !!r.githubToken,
        username: r.githubUsername || null,
        authMethod: r.githubAuthMethod || (r.githubToken ? "manual" : null),
      });
    });
    return true;
  }

  if (message.type === "DISCONNECT_GITHUB") {
    disconnectGithub().then(() => sendResponse({ disconnected: true }));
    return true;
  }

  if (message.type === "RESET_HISTORY_IMPORT") {
    chrome.storage.local.remove(["historyImportState"]).then(() => sendResponse({ reset: true }));
    return true;
  }
});

// ---------------------------------------------------------------------------
// GitHub Connect (Device Flow OAuth)
// ---------------------------------------------------------------------------
// Ends by writing to the SAME "githubToken" storage key that a manually
// pasted Personal Access Token uses — every other function in this file
// (pushToGitHub, findExistingFile, updateReadme, history import, etc.)
// already reads from that one key, so nothing else needs to change.

const GITHUB_CLIENT_ID = "Ov23lijEs9khKmBR44VJ";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

const GITHUB_DEVICE_FLOW_ALARM = "githubDeviceFlowPoll";

async function requestGithubDeviceCode() {
  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "repo" }),
  });
  if (!response.ok) throw new Error(`Failed to start GitHub sign-in (${response.status}).`);
  return response.json(); // { device_code, user_code, verification_uri, expires_in, interval }
}

async function getGithubDeviceFlowState() {
  const { githubDeviceFlow } = await chrome.storage.local.get(["githubDeviceFlow"]);
  return githubDeviceFlow || null;
}

async function saveGithubDeviceFlowState(state) {
  await chrome.storage.local.set({ githubDeviceFlow: state });
}

async function clearGithubDeviceFlowState() {
  await chrome.storage.local.remove(["githubDeviceFlow"]);
  chrome.alarms.clear(GITHUB_DEVICE_FLOW_ALARM);
}

async function connectGithubViaDeviceFlow() {
  try {
    const { device_code, user_code, verification_uri, expires_in, interval } = await requestGithubDeviceCode();

    await saveGithubDeviceFlowState({
      device_code,
      user_code,
      verification_uri,
      expires_at: Date.now() + expires_in * 1000,
      interval,
      status: "pending",
    });

    // Popup may not be open yet — that's fine, GET_GITHUB_DEVICE_FLOW_STATE
    // lets it recover the code + status on reopen regardless.
    chrome.runtime
      .sendMessage({ type: "GITHUB_DEVICE_CODE", user_code, verification_uri, expires_in })
      .catch(() => {});

    // Try immediately (handles fast approvers), then hand off to the alarm
    // for every check after that.
    await attemptGithubTokenPoll();

    // IMPORTANT: poll via chrome.alarms, NOT setTimeout. A plain setTimeout
    // loop silently dies the moment Chrome puts this idle service worker to
    // sleep — which can easily happen while the user is over on GitHub's
    // page authorizing. Alarms are the one mechanism Chrome guarantees will
    // wake this service worker back up, so the flow reliably finishes even
    // if the worker was killed and restarted in between polls.
    chrome.alarms.create(GITHUB_DEVICE_FLOW_ALARM, { periodInMinutes: 1 });
  } catch (err) {
    console.error("GitHub Device Flow failed to start:", err);
    await clearGithubDeviceFlowState();
    chrome.runtime
      .sendMessage({ type: "GITHUB_DEVICE_FLOW_RESULT", ok: false, message: err.message || String(err) })
      .catch(() => {});
  }
}

// A single poll attempt — called once immediately when the flow starts, and
// again on every alarm tick after that. State lives in storage (not memory),
// so this works correctly even if the service worker restarted in between.
async function attemptGithubTokenPoll() {
  const state = await getGithubDeviceFlowState();
  if (!state || state.status !== "pending") return; // nothing in progress

  if (Date.now() > state.expires_at) {
    await clearGithubDeviceFlowState();
    chrome.runtime
      .sendMessage({ type: "GITHUB_DEVICE_FLOW_RESULT", ok: false, message: "Code expired — click Connect to try again." })
      .catch(() => {});
    return;
  }

  const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code: state.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const data = await response.json();

  if (data.access_token) {
    const userResponse = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${data.access_token}`, Accept: "application/vnd.github+json" },
    });
    const userData = userResponse.ok ? await userResponse.json() : {};

    await chrome.storage.local.set({
      githubToken: data.access_token,
      githubUsername: userData.login || null,
      githubAuthMethod: "oauth",
    });
    await clearGithubDeviceFlowState();
    chrome.runtime
      .sendMessage({ type: "GITHUB_DEVICE_FLOW_RESULT", ok: true, username: userData.login || null })
      .catch(() => {});
    return;
  }

  if (data.error === "authorization_pending") return; // normal — the next alarm tick tries again
  if (data.error === "slow_down") return; // our 1-minute cadence already respects any reasonable slow_down request

  // Anything else is a real stop condition (expired, denied, or unexpected).
  await clearGithubDeviceFlowState();
  let message = "GitHub sign-in failed.";
  if (data.error === "expired_token") message = "Code expired — click Connect to try again.";
  else if (data.error === "access_denied") message = "Authorization was denied on GitHub.";
  else if (data.error_description) message = data.error_description;
  chrome.runtime.sendMessage({ type: "GITHUB_DEVICE_FLOW_RESULT", ok: false, message }).catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GITHUB_DEVICE_FLOW_ALARM) attemptGithubTokenPoll();
});

async function cancelGithubDeviceFlow() {
  await clearGithubDeviceFlowState();
}

async function disconnectGithub() {
  await chrome.storage.local.remove(["githubToken", "githubUsername", "githubAuthMethod"]);
}

// ---------------------------------------------------------------------------
// Full history import — walks the user's entire "Accepted" submission list
// and pushes every problem to GitHub, reusing the exact same push logic as
// the live sync (handleAcceptedSubmission / pushToGitHub) so there is only
// ONE code path that talks to GitHub.
// ---------------------------------------------------------------------------

const HISTORY_IMPORT_PAGE_SIZE = 20;
// Deliberately gentle pacing: this is a bulk backfill, not a single live
// event, and each problem already costs ~3-4 API calls (2 GraphQL + 1-2
// GitHub). A small delay keeps us well clear of GitHub's/LeetCode's rate
// limits even on a large history.
const HISTORY_IMPORT_DELAY_MS = 500;

let historyImportCancelRequested = false;

async function getHistoryImportState() {
  const { historyImportState } = await chrome.storage.local.get(["historyImportState"]);
  return (
    historyImportState || {
      status: "idle", // idle | running | paused | completed | error
      offset: 0,
      processedSlugs: [],
      imported: 0,
      failed: 0,
      currentTitle: null,
      lastError: null,
      startedAt: null,
      updatedAt: null,
    }
  );
}

async function saveHistoryImportState(state) {
  state.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ historyImportState: state });
  // Popup may not be open — sendMessage rejects silently in that case,
  // which is fine, since storage is the source of truth on reopen.
  chrome.runtime.sendMessage({ type: "HISTORY_IMPORT_PROGRESS", state }).catch(() => {});
}

function isStaleRunningState(state, staleAfterMs) {
  if (!state || state.status !== "running") return false;
  const lastUpdate = state.updatedAt ? new Date(state.updatedAt).getTime() : 0;
  return Date.now() - lastUpdate > staleAfterMs;
}

// Cancelling writes "paused" straight to storage (not just an in-memory
// flag) so the popup reflects it immediately even in the rare case the loop
// itself has already died — the in-memory flag still handles the normal
// case where the loop is alive and checks it between items.
async function cancelHistoryImport() {
  historyImportCancelRequested = true;
  const state = await getHistoryImportState();
  if (state.status === "running") {
    state.status = "paused";
    await saveHistoryImportState(state);
  }
}

// If Chrome ever terminates this service worker mid-import (it can, for a
// long-running background loop — see the Device Flow fix above for the same
// class of issue), storage is left saying "running" forever, with nothing
// left alive to ever change it. Without this check, clicking "Import" again
// would just see "running" and silently do nothing — the user would be
// stuck with no way to resume. A stale "running" (no progress in 2+ minutes)
// is treated as dead, not actually in progress.
const HISTORY_IMPORT_STALE_MS = 2 * 60 * 1000;

async function startHistoryImport() {
  const { githubToken, githubRepo } = await chrome.storage.local.get(["githubToken", "githubRepo"]);
  let state = await getHistoryImportState();

  if (state.status === "running" && !isStaleRunningState(state, HISTORY_IMPORT_STALE_MS)) {
    console.log("History import already running — ignoring duplicate start.");
    return;
  }
  if (state.status === "running") {
    console.log("Previous history import appears to have stopped unexpectedly — resuming.");
  }
  if (!githubToken || !githubRepo) {
    state.status = "error";
    state.lastError = "GitHub not connected — save your token + repo first.";
    await saveHistoryImportState(state);
    return;
  }

  historyImportCancelRequested = false;
  state.status = "running";
  state.startedAt = state.startedAt || new Date().toISOString();
  state.lastError = null;
  await saveHistoryImportState(state);

  // Resuming an interrupted import picks up from the saved offset/slug set,
  // instead of starting over and re-pushing everything from scratch.
  const processedSet = new Set(state.processedSlugs);

  try {
    while (true) {
      if (historyImportCancelRequested) {
        state.status = "paused";
        await saveHistoryImportState(state);
        console.log("History import paused by user.");
        return;
      }

      const page = await fetchAcceptedSubmissionsPage(state.offset, HISTORY_IMPORT_PAGE_SIZE);
      const submissions = page?.submissions || [];

      for (const sub of submissions) {
        if (historyImportCancelRequested) {
          state.status = "paused";
          await saveHistoryImportState(state);
          return;
        }

        // submissionList returns EVERY accepted submission, including
        // repeat/resubmitted attempts at the same problem. Since it's
        // newest-first, the first time we see a titleSlug is already its
        // latest accepted version — anything after that is a duplicate.
        if (processedSet.has(sub.titleSlug)) continue;

        state.currentTitle = sub.title;
        await saveHistoryImportState(state);

        const result = await handleAcceptedSubmission(sub.id, sub.titleSlug, { updateReadmeAfter: false });

        processedSet.add(sub.titleSlug);
        state.processedSlugs = Array.from(processedSet);
        if (result.ok) state.imported += 1;
        else state.failed += 1;
        await saveHistoryImportState(state);

        await new Promise((r) => setTimeout(r, HISTORY_IMPORT_DELAY_MS));
      }

      state.offset += HISTORY_IMPORT_PAGE_SIZE;
      await saveHistoryImportState(state);

      // Batched refresh: once per page rather than once per problem, so a
      // large import doesn't produce hundreds of extra README commits.
      const [owner, repo] = githubRepo.split("/");
      await updateReadme(owner, repo, githubToken);

      if (!page?.hasNext) break;
    }

    state.status = "completed";
    state.currentTitle = null;
    await saveHistoryImportState(state);

    // Final pass to be certain the README reflects everything imported.
    const [owner, repo] = githubRepo.split("/");
    await updateReadme(owner, repo, githubToken);

    console.log(`History import complete: ${state.imported} imported, ${state.failed} failed.`);
  } catch (err) {
    // A hard failure (e.g. LeetCode's submissionList shape changed) stops
    // the loop, but the saved offset/processedSlugs mean clicking "Import"
    // again resumes instead of re-processing everything already done.
    console.error("History import stopped by an error:", err);
    state.status = "error";
    state.lastError = err.message || String(err);
    await saveHistoryImportState(state);
  }
}

// ---------------------------------------------------------------------------
// Folder logic (ported from config.json's folder_priority list)
// ---------------------------------------------------------------------------

const FOLDER_PRIORITY = [
  { tags: ["Array"], folder: "Array" },
  { tags: ["String"], folder: "String" },
  { tags: ["Linked List"], folder: "LinkedList" },
  { tags: ["Matrix"], folder: "Matrix" },
  { tags: ["Binary Tree", "Binary Search Tree", "N-ary Tree", "Tree"], folder: "Trees" },
  { tags: ["Graph"], folder: "Graph" },
  { tags: ["Stack", "Monotonic Stack"], folder: "Stack" },
  { tags: ["Queue", "Monotonic Queue"], folder: "Queue" },
  { tags: ["Heap (Priority Queue)"], folder: "Heap" },
  { tags: ["Trie"], folder: "Trie" },
  { tags: ["Hash Table", "Hash Function"], folder: "HashMap" },
  { tags: ["Dynamic Programming"], folder: "DynamicProgramming" },
  { tags: ["Backtracking"], folder: "Backtracking" },
  { tags: ["Greedy"], folder: "Greedy" },
  { tags: ["Binary Search"], folder: "BinarySearch" },
  { tags: ["Math"], folder: "Math" },
  { tags: ["Bit Manipulation"], folder: "BitManipulation" },
  { tags: ["Sliding Window"], folder: "SlidingWindow" },
  { tags: ["Two Pointers"], folder: "TwoPointers" },
  { tags: ["Sorting"], folder: "Sorting" },
  { tags: ["Recursion"], folder: "Recursion" },
  { tags: ["Design"], folder: "Design" },
];
const DEFAULT_FOLDER = "Untagged";
const PROBLEMS_SUBDIR = "LeetCode Problems";

function determineFolder(topicTags) {
  if (!topicTags || topicTags.length === 0) return DEFAULT_FOLDER;
  const tagNames = new Set(topicTags.map((t) => t.name));
  for (const entry of FOLDER_PRIORITY) {
    if (entry.tags.some((t) => tagNames.has(t))) return entry.folder;
  }
  return DEFAULT_FOLDER;
}

function sanitizeTitle(title) {
  const cleaned = title.replace(/[^a-zA-Z0-9\s]/g, "");
  return cleaned.split(/\s+/).filter(Boolean).join("_");
}

const LANG_EXTENSION = {
  java: "java", python3: "py", python: "py", "c++": "cpp", cpp: "cpp",
  javascript: "js", c: "c", "c#": "cs", csharp: "cs", go: "go",
  kotlin: "kt", swift: "swift", typescript: "ts",
};

function buildFilePath(folder, frontendId, title, langName) {
  const key = (langName || "").toLowerCase();
  const known = Object.prototype.hasOwnProperty.call(LANG_EXTENSION, key);
  const ext = known ? LANG_EXTENSION[key] : "txt";
  const filename = `${frontendId}_${sanitizeTitle(title)}.${ext}`;
  return { path: `${PROBLEMS_SUBDIR}/${folder}/${filename}`, unsupportedLanguage: !known };
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

function toBase64(str) {
  const utf8Bytes = new TextEncoder().encode(str);
  let binary = "";
  utf8Bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function fromBase64(b64) {
  // GitHub's Contents API returns base64 with embedded newlines — atob()
  // chokes on those, so strip them first.
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function encodeGithubPath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

// Retries transient failures (network errors, GitHub 5xx, and 403 rate-limit
// responses) with increasing delays. Does NOT retry 401/404/422 etc. —
// those are real problems (bad token, wrong repo) that a retry can't fix,
// so we fail fast instead of wasting time.
async function githubRequest(path, method, body, token, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAYS_MS = [1000, 2000, 4000];

  let response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    // fetch() itself threw — offline, DNS failure, connection reset, etc.
    if (attempt < MAX_ATTEMPTS) {
      console.error(`GitHub request network error, retrying (attempt ${attempt}):`, networkErr);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
      return githubRequest(path, method, body, token, attempt + 1);
    }
    throw networkErr;
  }

  const isRateLimited = response.status === 403 &&
    response.headers.get("x-ratelimit-remaining") === "0";
  const isTransientServerError = response.status >= 500;

  if ((isRateLimited || isTransientServerError) && attempt < MAX_ATTEMPTS) {
    console.error(`GitHub request failed (${response.status}), retrying (attempt ${attempt})`);
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    return githubRequest(path, method, body, token, attempt + 1);
  }

  return response;
}

async function getFileSha(owner, repo, filePath, token) {
  const response = await githubRequest(
    `/repos/${owner}/${repo}/contents/${encodeGithubPath(filePath)}`, "GET", null, token
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to check existing file: ${response.status}`);
  const data = await response.json();
  return data.sha;
}

async function putFile(owner, repo, filePath, contentBase64, message, sha, token) {
  const body = { message, content: contentBase64 };
  if (sha) body.sha = sha;

  const response = await githubRequest(
    `/repos/${owner}/${repo}/contents/${encodeGithubPath(filePath)}`, "PUT", body, token
  );
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GitHub push failed (${response.status}): ${errText}`);
  }
  return response.json();
}

async function deleteFile(owner, repo, filePath, sha, message, token) {
  const response = await githubRequest(
    `/repos/${owner}/${repo}/contents/${encodeGithubPath(filePath)}`, "DELETE", { message, sha }, token
  );
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GitHub delete failed (${response.status}): ${errText}`);
  }
}

// If deleting the old-language file fails once, wait briefly and try again —
// most GitHub failures at this point are transient (network blip, momentary
// rate limit). If it fails a second time, don't just swallow it: persist a
// record so a duplicate file left behind is at least discoverable later,
// instead of vanishing into the console.
async function cleanupOldFile(owner, repo, oldFilePath, sha, message, token, frontendId) {
  try {
    await deleteFile(owner, repo, oldFilePath, sha, message, token);
    console.log(`Removed old file (language changed): ${oldFilePath}`);
    return;
  } catch (firstErr) {
    console.error("Could not remove old-language file, retrying once:", firstErr);
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));

  try {
    await deleteFile(owner, repo, oldFilePath, sha, message, token);
    console.log(`Removed old file on retry: ${oldFilePath}`);
  } catch (secondErr) {
    console.error("Could not remove old-language file after retry (non-fatal):", secondErr);
    await recordFailedCleanup(oldFilePath, frontendId, String(secondErr));
  }
}

async function recordFailedCleanup(filePath, frontendId, errorMessage) {
  const { failedCleanups = [] } = await chrome.storage.local.get(["failedCleanups"]);
  failedCleanups.push({
    filePath,
    frontendId,
    error: errorMessage,
    timestamp: new Date().toISOString(),
  });
  await chrome.storage.local.set({ failedCleanups });
  console.error(
    `⚠️ Duplicate file left behind for problem ${frontendId}: ${filePath}. ` +
      `Saved to chrome.storage.local["failedCleanups"] — remove it manually on GitHub for now.`
  );
}

async function findExistingFile(owner, repo, folder, frontendId, token) {
  // IMPORTANT: files are actually stored under "LeetCode Problems/{folder}/...",
  // so we must look in the SAME base path here, otherwise we always think the
  // file is new (resubmission/language-change detection silently breaks).
  const dirPath = `${PROBLEMS_SUBDIR}/${folder}`;

  const response = await githubRequest(
    `/repos/${owner}/${repo}/contents/${encodeGithubPath(dirPath)}`, "GET", null, token
  );
  if (response.status === 404) return null; // folder doesn't exist yet — definitely new
  if (!response.ok) throw new Error(`Failed to list folder: ${response.status}`);

  const files = await response.json();
  // Find any file for this problem number, REGARDLESS of language/extension
  // (e.g. "73_Set_Matrix_Zeroes.java" or "73_Set_Matrix_Zeroes.cpp" both match "73_").
  // Explicitly restrict to actual files, since the Contents API can also return subdirectories.
  return files.find((f) => f.type === "file" && f.name.startsWith(`${frontendId}_`)) || null;
}

// ---------------------------------------------------------------------------
// README auto-stats
// ---------------------------------------------------------------------------
// Only touches content between the marker comments the user already has in
// their README (<!-- AUTO-TOPICS:START/END --> and <!-- AUTO-STATS:START/END -->).
// If a marker pair is missing, that section is left completely alone — we
// never invent structure the user didn't already put there.

const README_PATH = "README.md";

// Maps each checklist line to the GitHub folder(s) that count toward it.
// Some checklist items (e.g. "Stack / Queue") map to more than one folder.
const TOPIC_CHECKLIST = [
  { label: "Array", folders: ["Array"] },
  { label: "String", folders: ["String"] },
  { label: "Linked List", folders: ["LinkedList"] },
  { label: "Matrix", folders: ["Matrix"] },
  { label: "Trees", folders: ["Trees"] },
  { label: "Graph", folders: ["Graph"] },
  { label: "Stack / Queue", folders: ["Stack", "Queue"] },
  { label: "Heap", folders: ["Heap"] },
  { label: "Trie", folders: ["Trie"] },
  { label: "Hashing", folders: ["HashMap"] },
  { label: "Dynamic Programming", folders: ["DynamicProgramming"] },
  { label: "Backtracking", folders: ["Backtracking"] },
  { label: "Greedy", folders: ["Greedy"] },
  { label: "Binary Search", folders: ["BinarySearch"] },
  { label: "Math", folders: ["Math"] },
  { label: "Bit Manipulation", folders: ["BitManipulation"] },
  { label: "Sliding Window", folders: ["SlidingWindow"] },
  { label: "Two Pointers", folders: ["TwoPointers"] },
  { label: "Sorting", folders: ["Sorting"] },
];

// Lists "LeetCode Problems/", then counts files inside each topic subfolder
// that's actually present. Folders with zero files (or that don't exist yet)
// simply don't appear — same effect as a count of 0.
async function getFolderCounts(owner, repo, token) {
  const rootResponse = await githubRequest(
    `/repos/${owner}/${repo}/contents/${encodeGithubPath(PROBLEMS_SUBDIR)}`, "GET", null, token
  );
  if (rootResponse.status === 404) return {};
  if (!rootResponse.ok) throw new Error(`Failed to list "${PROBLEMS_SUBDIR}": ${rootResponse.status}`);

  const entries = await rootResponse.json();
  const subfolders = entries.filter((e) => e.type === "dir");

  const counts = {};
  for (const folder of subfolders) {
    const listResponse = await githubRequest(
      `/repos/${owner}/${repo}/contents/${encodeGithubPath(`${PROBLEMS_SUBDIR}/${folder.name}`)}`,
      "GET", null, token
    );
    if (!listResponse.ok) continue; // skip a folder we can't read rather than failing the whole README
    const files = await listResponse.json();
    counts[folder.name] = files.filter((f) => f.type === "file").length;
  }
  return counts;
}

function buildTopicsChecklist(folderCounts) {
  return TOPIC_CHECKLIST.map((item) => {
    const solved = item.folders.some((f) => (folderCounts[f] || 0) > 0);
    return `- [${solved ? "x" : " "}] ${item.label}`;
  }).join("\n");
}

function buildStatsTable(folderCounts) {
  const total = Object.values(folderCounts).reduce((sum, n) => sum + n, 0);
  const rows = Object.entries(folderCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([folder, count]) => `| ${folder} | ${count} |`)
    .join("\n");

  return `**Total Solved:** ${total}\n\n| Topic | Solved |\n|-------|--------|\n${rows}`;
}

// Replaces only the text strictly between a "<!-- X:START -->" / "<!-- X:END -->"
// pair. Returns the content unchanged if the markers aren't found, so a
// README without them is never modified.
function replaceMarkerSection(content, markerName, newInnerContent) {
  const pattern = new RegExp(
    `(<!--\\s*${markerName}:START\\s*-->)([\\s\\S]*?)(<!--\\s*${markerName}:END\\s*-->)`
  );
  if (!pattern.test(content)) return content;
  return content.replace(pattern, `$1\n${newInnerContent}\n$3`);
}

// The LeetCode stats card embeds the username directly in its image URL
// (https://leetcard.jacoblin.cool/{username}?...). We keep that in sync with
// the username saved in settings, without needing a marker for it.
function applyStatsCardUsername(content, username) {
  if (!username) return content;
  return content.replace(
    /(https:\/\/leetcard\.jacoblin\.cool\/)[^"?)\s]+/g,
    `$1${encodeURIComponent(username)}`
  );
}

function buildStatsCardBlock(username) {
  const safeUsername = username ? encodeURIComponent(username) : "your-leetcode-username";
  return (
    `## 📊 LeetCode Stats\n` +
    `<div align="center">\n` +
    `  <img src="https://leetcard.jacoblin.cool/${safeUsername}?theme=dark&font=baloo2&ext=heatmap" alt="LeetCode Stats" />\n` +
    `</div>`
  );
}

function buildTopicsSectionBlock(folderCounts) {
  return (
    `## 🗂️ Topics Covered\n` +
    `<details>\n` +
    `<summary><b>Click to expand topic checklist</b></summary>\n\n` +
    `<!-- AUTO-TOPICS:START -->\n${buildTopicsChecklist(folderCounts)}\n<!-- AUTO-TOPICS:END -->\n` +
    `</details>`
  );
}

function buildStatsSectionBlock(folderCounts) {
  return (
    `## 📈 Auto-Generated Progress\n` +
    `<!-- AUTO-STATS:START -->\n${buildStatsTable(folderCounts)}\n<!-- AUTO-STATS:END -->`
  );
}

// A brand-new repo typically has either no README.md at all, or just a bare
// "# repo-name" from GitHub's own "Initialize with README" checkbox — so a
// fresh install must be able to produce a complete, working README with zero
// manual setup, not just silently do nothing until the user copies in a
// template by hand.
function buildDefaultReadme(folderCounts, username) {
  return [
    "# LeetCode Progress",
    "",
    buildStatsCardBlock(username),
    "",
    "---",
    "",
    buildTopicsSectionBlock(folderCounts),
    "",
    "---",
    "",
    buildStatsSectionBlock(folderCounts),
    "",
  ].join("\n");
}

async function updateReadme(owner, repo, token) {
  try {
    const folderCounts = await getFolderCounts(owner, repo, token);
    // Read live from LeetCode's own session rather than a saved setting —
    // this is always accurate (including across account switches) and one
    // less thing for the user to configure. If the lookup fails for any
    // reason (logged out, network hiccup), we fall back to whatever was
    // already in the README rather than blocking the stats update entirely.
    const leetcodeUsername = await fetchLoggedInUsername().catch((err) => {
      console.error("Couldn't detect the logged-in LeetCode username (non-fatal):", err);
      return null;
    });

    const response = await githubRequest(
      `/repos/${owner}/${repo}/contents/${encodeGithubPath(README_PATH)}`, "GET", null, token
    );

    if (response.status === 404) {
      // No README at all yet — create a complete one from scratch so this
      // works out of the box for every new user, not just ones who happen
      // to already have the exact template in place.
      const freshReadme = buildDefaultReadme(folderCounts, leetcodeUsername);
      await putFile(owner, repo, README_PATH, toBase64(freshReadme), "Create README with LeetCode stats [automated]", null, token);
      console.log("✅ Created a new README.md with stats.");
      return;
    }
    if (!response.ok) throw new Error(`Failed to fetch README: ${response.status}`);

    const data = await response.json();
    const currentContent = fromBase64(data.content);
    let updated = currentContent;

    const hasTopicsMarkers = /<!--\s*AUTO-TOPICS:START\s*-->/.test(updated);
    const hasStatsMarkers = /<!--\s*AUTO-STATS:START\s*-->/.test(updated);
    const hasStatsCard = /https:\/\/leetcard\.jacoblin\.cool\//.test(updated);

    if (hasTopicsMarkers) {
      updated = replaceMarkerSection(updated, "AUTO-TOPICS", buildTopicsChecklist(folderCounts));
    } else {
      // Existing README (even a trivial "# repo-name") is never discarded —
      // the missing section is appended so nothing the user already wrote
      // is lost, while every user still ends up with working sections.
      updated = updated.trimEnd() + "\n\n---\n\n" + buildTopicsSectionBlock(folderCounts) + "\n";
    }

    if (hasStatsMarkers) {
      updated = replaceMarkerSection(updated, "AUTO-STATS", buildStatsTable(folderCounts));
    } else {
      updated = updated.trimEnd() + "\n\n---\n\n" + buildStatsSectionBlock(folderCounts) + "\n";
    }

    if (hasStatsCard) {
      updated = applyStatsCardUsername(updated, leetcodeUsername);
    } else {
      updated = buildStatsCardBlock(leetcodeUsername) + "\n\n---\n\n" + updated.trimStart();
    }

    if (updated === currentContent) {
      console.log("README stats already up to date — no commit needed.");
      return;
    }

    await putFile(owner, repo, README_PATH, toBase64(updated), "Update README stats [automated]", data.sha, token);
    console.log("✅ README stats updated.");
  } catch (err) {
    // README sync is a nice-to-have layered on top of the actual push — a
    // failure here should never be reported as if the code push itself failed.
    console.error("Failed to update README stats (non-fatal):", err);
  }
}

// ---------------------------------------------------------------------------
// Google Sheets sync
// ---------------------------------------------------------------------------
// NOTE: requires manifest.json's oauth2.client_id to be a real Google Cloud
// OAuth client (Chrome Extension type) before any of this will actually
// work. Until that's set, these calls fail — caught and logged as
// "non-fatal", exactly like the README sync, so it never breaks the core
// GitHub push.

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEET_TAB_NAME = "Sheet1"; // default tab name Google gives new spreadsheets
const SHEET_HEADER_ROW = ["Problem ID", "Title", "Difficulty", "Topics", "Language", "Date Solved", "GitHub Link"];

function getGoogleAuthToken({ interactive = true } = {}) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "No Google auth token returned"));
        return;
      }
      resolve(token);
    });
  });
}

async function sheetsRequest(path, method, body, token) {
  return fetch(`${SHEETS_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Creates a brand-new spreadsheet with a header row. Called once per user —
// after this, the spreadsheetId is saved and reused for every future sync.
async function createSpreadsheet(token) {
  const response = await sheetsRequest("", "POST", {
    properties: { title: "LeetCode Progress Tracker" },
    sheets: [{ properties: { title: SHEET_TAB_NAME } }],
  }, token);
  if (!response.ok) throw new Error(`Failed to create spreadsheet: ${response.status}`);
  const data = await response.json();
  const spreadsheetId = data.spreadsheetId;

  await sheetsRequest(
    `/${spreadsheetId}/values/${SHEET_TAB_NAME}!A1:G1?valueInputOption=RAW`,
    "PUT", { values: [SHEET_HEADER_ROW] }, token
  );

  return spreadsheetId;
}

// Called from the popup's "Turn On" toggle. Reuses the saved spreadsheet if
// it still exists/is accessible; otherwise makes a fresh one. Also flips
// sheetsEnabled on — this flag (not just "a spreadsheet exists") is what
// syncProblemToSheet actually checks, so a user who once connected and later
// turned it off never gets surprise syncs.
async function connectGoogleSheets() {
  try {
    const token = await getGoogleAuthToken({ interactive: true });
    const { sheetsSpreadsheetId } = await chrome.storage.local.get(["sheetsSpreadsheetId"]);

    let spreadsheetId = sheetsSpreadsheetId;
    if (spreadsheetId) {
      const check = await sheetsRequest(`/${spreadsheetId}?fields=spreadsheetId`, "GET", null, token);
      if (!check.ok) spreadsheetId = null; // saved sheet was deleted/inaccessible — make a new one
    }
    if (!spreadsheetId) {
      spreadsheetId = await createSpreadsheet(token);
    }

    await chrome.storage.local.set({ sheetsSpreadsheetId: spreadsheetId, sheetsEnabled: true });

    // Tell the caller whether there are already-pushed GitHub problems that
    // predate this connection — the popup uses this to offer a one-time
    // backfill instead of silently leaving them out of the sheet forever.
    const backfillCount = await getSheetsBackfillCandidateCount().catch(() => 0);

    return { ok: true, spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, backfillCount };
  } catch (err) {
    console.error("Google Sheets connect failed:", err);
    return { ok: false, message: err.message || String(err) };
  }
}

// Turns syncing off WITHOUT deleting the spreadsheet or revoking Google
// access — so turning it back on later is instant, no re-auth or new sheet.
async function disableGoogleSheets() {
  await chrome.storage.local.set({ sheetsEnabled: false });
}

// Finds an existing row for this problem (matched by ID in column A), so a
// resubmission UPDATES that row instead of creating a duplicate — same
// "GitHub/GitHub-equivalent is source of truth" principle as the code sync.
async function findExistingSheetRow(spreadsheetId, frontendId, token) {
  const response = await sheetsRequest(`/${spreadsheetId}/values/${SHEET_TAB_NAME}!A2:A`, "GET", null, token);
  if (!response.ok) return null;
  const data = await response.json();
  const rows = data.values || [];
  const rowIndex = rows.findIndex((r) => r[0] === String(frontendId));
  return rowIndex === -1 ? null : rowIndex + 2; // +2: header row + 1-based indexing
}

async function syncProblemToSheet(question, langName, { owner, repo, filePath }) {
  try {
    const { sheetsSpreadsheetId, sheetsEnabled } = await chrome.storage.local.get(["sheetsSpreadsheetId", "sheetsEnabled"]);
    if (!sheetsEnabled || !sheetsSpreadsheetId) return; // user hasn't turned this on — nothing to do, not an error

    const token = await getGoogleAuthToken({ interactive: false });
    const frontendId = question.questionFrontendId;
    // "HEAD" resolves to whatever the repo's default branch actually is
    // (main/master/etc.) without needing an extra API call to look it up.
    const githubLink = `https://github.com/${owner}/${repo}/blob/HEAD/${encodeGithubPath(filePath)}`;
    const row = [
      frontendId,
      question.title,
      question.difficulty || "",
      (question.topicTags || []).map((t) => t.name).join(", "),
      langName,
      new Date().toISOString().split("T")[0],
      githubLink,
    ];

    const existingRowNum = await findExistingSheetRow(sheetsSpreadsheetId, frontendId, token);
    if (existingRowNum) {
      await sheetsRequest(
        `/${sheetsSpreadsheetId}/values/${SHEET_TAB_NAME}!A${existingRowNum}:G${existingRowNum}?valueInputOption=RAW`,
        "PUT", { values: [row] }, token
      );
    } else {
      await sheetsRequest(
        `/${sheetsSpreadsheetId}/values/${SHEET_TAB_NAME}!A:G:append?valueInputOption=RAW`,
        "POST", { values: [row] }, token
      );
    }
  } catch (err) {
    // Sheets sync is an optional layer on top of the real push — same
    // philosophy as README sync. Never let it report the push itself as failed.
    console.error("Failed to sync to Google Sheets (non-fatal):", err);
  }
}

// ---------------------------------------------------------------------------
// Google Sheets backfill — for problems that were already pushed to GitHub
// BEFORE Sheets sync was turned on (or while it was temporarily off). Never
// touches GitHub — only adds the missing rows to the sheet.
// ---------------------------------------------------------------------------

// Reconstructs {frontendId, title-guess, extension} for every problem file
// actually sitting in the repo, straight from the filenames — this is the
// same naming scheme buildFilePath() uses, so it reverses cleanly.
async function listAllGithubProblems(owner, repo, token) {
  const rootResponse = await githubRequest(
    `/repos/${owner}/${repo}/contents/${encodeGithubPath(PROBLEMS_SUBDIR)}`, "GET", null, token
  );
  if (rootResponse.status === 404) return [];
  if (!rootResponse.ok) throw new Error(`Failed to list "${PROBLEMS_SUBDIR}": ${rootResponse.status}`);

  const entries = await rootResponse.json();
  const subfolders = entries.filter((e) => e.type === "dir");

  const problems = [];
  for (const folder of subfolders) {
    const listResponse = await githubRequest(
      `/repos/${owner}/${repo}/contents/${encodeGithubPath(`${PROBLEMS_SUBDIR}/${folder.name}`)}`, "GET", null, token
    );
    if (!listResponse.ok) continue;
    const files = await listResponse.json();
    for (const f of files) {
      if (f.type !== "file") continue;
      const match = f.name.match(/^(\d+)_(.+)\.([a-zA-Z0-9]+)$/);
      if (!match) continue;
      problems.push({
        frontendId: match[1],
        titleGuess: match[2].replace(/_/g, " "),
        extension: match[3].toLowerCase(),
        folder: folder.name,
        path: f.path,
      });
    }
  }
  return problems;
}

// Best-effort reverse of a title into the URL slug LeetCode would use — this
// is how LeetCode derives slugs for the vast majority of problem titles.
// A guess that doesn't resolve is skipped (reported, never silently lost),
// rather than guessed at further or failing the whole backfill.
function titleToSlugGuess(title) {
  return title.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const EXT_TO_LANG_DISPLAY = {
  java: "Java", py: "Python3", cpp: "C++", js: "JavaScript", c: "C",
  cs: "C#", go: "Go", kt: "Kotlin", swift: "Swift", ts: "TypeScript",
};

async function getSheetLoggedFrontendIds(spreadsheetId, token) {
  const response = await sheetsRequest(`/${spreadsheetId}/values/${SHEET_TAB_NAME}!A2:A`, "GET", null, token);
  if (!response.ok) return new Set();
  const data = await response.json();
  return new Set((data.values || []).map((row) => String(row[0]).trim()));
}

async function getSheetsBackfillCandidateCount() {
  const { githubToken, githubRepo, sheetsSpreadsheetId } = await chrome.storage.local.get([
    "githubToken", "githubRepo", "sheetsSpreadsheetId",
  ]);
  if (!githubToken || !githubRepo || !sheetsSpreadsheetId) return 0;
  const [owner, repo] = githubRepo.split("/");
  const googleToken = await getGoogleAuthToken({ interactive: false });

  const [githubProblems, loggedIds] = await Promise.all([
    listAllGithubProblems(owner, repo, githubToken),
    getSheetLoggedFrontendIds(sheetsSpreadsheetId, googleToken),
  ]);
  return githubProblems.filter((p) => !loggedIds.has(String(p.frontendId))).length;
}

const SHEETS_BACKFILL_DELAY_MS = 400;
let sheetsBackfillCancelRequested = false;

async function getSheetsBackfillState() {
  const { sheetsBackfillState } = await chrome.storage.local.get(["sheetsBackfillState"]);
  return sheetsBackfillState || { status: "idle", total: 0, done: 0, imported: 0, skipped: 0, currentTitle: null };
}

async function saveSheetsBackfillState(state) {
  state.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ sheetsBackfillState: state });
  chrome.runtime.sendMessage({ type: "SHEETS_BACKFILL_PROGRESS", state }).catch(() => {});
}

async function cancelSheetsBackfill() {
  sheetsBackfillCancelRequested = true;
  const state = await getSheetsBackfillState();
  if (state.status === "running") {
    state.status = "paused";
    await saveSheetsBackfillState(state);
  }
}

const SHEETS_BACKFILL_STALE_MS = 2 * 60 * 1000;

async function startSheetsBackfill() {
  const { githubToken, githubRepo, sheetsSpreadsheetId } = await chrome.storage.local.get([
    "githubToken", "githubRepo", "sheetsSpreadsheetId",
  ]);
  if (!githubToken || !githubRepo || !sheetsSpreadsheetId) return;

  const existingState = await getSheetsBackfillState();
  if (existingState.status === "running" && !isStaleRunningState(existingState, SHEETS_BACKFILL_STALE_MS)) {
    console.log("Sheets backfill already running — ignoring duplicate start.");
    return;
  }

  const [owner, repo] = githubRepo.split("/");

  sheetsBackfillCancelRequested = false;
  let state = { status: "running", total: 0, done: 0, imported: 0, skipped: 0, currentTitle: null };
  await saveSheetsBackfillState(state);

  try {
    const googleToken = await getGoogleAuthToken({ interactive: false });
    const [githubProblems, loggedIds] = await Promise.all([
      listAllGithubProblems(owner, repo, githubToken),
      getSheetLoggedFrontendIds(sheetsSpreadsheetId, googleToken),
    ]);
    const missing = githubProblems.filter((p) => !loggedIds.has(String(p.frontendId)));

    state.total = missing.length;
    await saveSheetsBackfillState(state);

    for (const p of missing) {
      if (sheetsBackfillCancelRequested) {
        state.status = "paused";
        await saveSheetsBackfillState(state);
        return;
      }

      state.currentTitle = p.titleGuess;
      await saveSheetsBackfillState(state);

      const slugGuess = titleToSlugGuess(p.titleGuess);
      try {
        const question = await fetchQuestionDetails(slugGuess);
        if (question && question.questionFrontendId) {
          const langName = EXT_TO_LANG_DISPLAY[p.extension] || p.extension.toUpperCase();
          await syncProblemToSheet(question, langName, { owner, repo, filePath: p.path });
          state.imported += 1;
        } else {
          state.skipped += 1; // couldn't confidently match this filename to a LeetCode problem
        }
      } catch (err) {
        console.error(`Sheets backfill: couldn't match "${p.titleGuess}" (${slugGuess}):`, err);
        state.skipped += 1;
      }

      state.done += 1;
      await saveSheetsBackfillState(state);
      await new Promise((r) => setTimeout(r, SHEETS_BACKFILL_DELAY_MS));
    }

    state.status = "completed";
    state.currentTitle = null;
    await saveSheetsBackfillState(state);
  } catch (err) {
    console.error("Sheets backfill stopped by an error:", err);
    state.status = "error";
    state.lastError = err.message || String(err);
    await saveSheetsBackfillState(state);
  }
}

// ---------------------------------------------------------------------------
// Main push flow (new problems only for now — resubmit/README come next)
// ---------------------------------------------------------------------------

// Writes a visible result the popup can show ("Last Sync"), and sets an
// icon badge so the user notices success/failure without opening DevTools.
const MAX_SYNC_HISTORY = 50;

// Writes a visible result the popup can show ("Last Sync" + history list),
// and sets an icon badge so the user notices success/failure without
// opening DevTools.
async function recordSyncStatus({ ok, frontendId, title, message }) {
  const entry = { ok, frontendId, title, message, timestamp: new Date().toISOString() };

  const { syncHistory = [] } = await chrome.storage.local.get(["syncHistory"]);
  syncHistory.unshift(entry); // newest first
  if (syncHistory.length > MAX_SYNC_HISTORY) syncHistory.length = MAX_SYNC_HISTORY;

  await chrome.storage.local.set({ lastSync: entry, syncHistory });

  try {
    chrome.action.setBadgeText({ text: ok ? "✓" : "!" });
    chrome.action.setBadgeBackgroundColor({ color: ok ? "#2ea44f" : "#d73a49" });
  } catch (badgeErr) {
    console.error("Could not set badge:", badgeErr);
  }
}

async function pushToGitHub(titleSlug, question, code, langName, { updateReadmeAfter = true, updateSheetAfter = true } = {}) {
  const { githubToken, githubRepo } = await chrome.storage.local.get(["githubToken", "githubRepo"]);
  if (!githubToken || !githubRepo) {
    console.error("GitHub settings missing — open the extension popup and save your token + repo.");
    await recordSyncStatus({
      ok: false,
      frontendId: question.questionFrontendId,
      title: question.title,
      message: "GitHub not connected — open the popup and save your token + repo.",
    });
    return;
  }
  const [owner, repo] = githubRepo.split("/");

  const folder = determineFolder(question.topicTags);
  const frontendId = question.questionFrontendId;

  // GitHub is our single source of truth: look for ANY file starting with
  // "{frontendId}_" in this folder, regardless of language/extension.
  const existingFile = await findExistingFile(owner, repo, folder, frontendId, githubToken);
  const isResubmit = !!existingFile;
  const oldFilePath = existingFile ? existingFile.path : null;

  const { path: filePath, unsupportedLanguage } = buildFilePath(folder, frontendId, question.title, langName);
  if (unsupportedLanguage) {
    console.error(
      `⚠️ Unrecognized language "${langName}" — saving as .txt instead. ` +
        `Add it to LANG_EXTENSION in background.js if you want a proper file extension.`
    );
  }
  const contentBase64 = toBase64(code);
  const actionWord = isResubmit ? "Resubmit" : "Solve";
  const actionPastTense = isResubmit ? "Resubmitted" : "Solved";
  const commitMessage = `${actionWord} ${frontendId}. ${question.title}`;

  console.log(`Pushing to: ${filePath}`);

  try {
    // Push the NEW file first — only delete the old one AFTER this succeeds,
    // so a failure never leaves us with neither file (safer ordering).
    const existingSha = oldFilePath === filePath ? existingFile.sha : null;
    await putFile(owner, repo, filePath, contentBase64, commitMessage, existingSha, githubToken);
    console.log(`✅ Pushed: ${commitMessage}`);

    // If the language changed since last time, the old file has a
    // different name — remove it so we don't end up with two files.
    if (oldFilePath && oldFilePath !== filePath) {
      await cleanupOldFile(owner, repo, oldFilePath, existingFile.sha, commitMessage, githubToken, frontendId);
    }

    // README stats reflect actual files in the repo, so refresh it only
    // AFTER this push (and any cleanup) has landed. Bulk import passes
    // updateReadmeAfter=false and updates it in batches instead, so a
    // 500-problem import doesn't trigger 500 extra README commits.
    if (updateReadmeAfter) {
      await updateReadme(owner, repo, githubToken);
    }

    // Sheets sync is independent of GitHub/README — a lightweight row
    // update, not a full-file rewrite, so it runs per-problem even during
    // bulk import rather than being batched like the README.
    if (updateSheetAfter) {
      await syncProblemToSheet(question, langName, { owner, repo, filePath });
    }

    await recordSyncStatus({
      ok: true,
      frontendId,
      title: question.title,
      message: unsupportedLanguage
        ? `Synced, but "${langName}" isn't a known language — saved as .txt.`
        : `${actionPastTense} successfully.`,
    });
  } catch (err) {
    console.error("❌ Push failed:", err);
    await recordSyncStatus({
      ok: false,
      frontendId,
      title: question.title,
      message: `Push failed: ${err.message || err}`,
    });
  }
}