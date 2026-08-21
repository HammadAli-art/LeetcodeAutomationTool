// This runs in the background, independent of any specific page.
console.log("LeetCode GitHub Sync: background service worker loaded.");

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
      console.error("LeetCode GitHub Sync:", msg, question);
      return { ok: false, message: msg };
    }
    if (!code || typeof code !== "string" || !code.trim()) {
      const msg = `submission code missing/empty for submission: ${submissionId}`;
      console.error("LeetCode GitHub Sync:", msg);
      return { ok: false, message: msg };
    }
    if (!langName) {
      const msg = `language missing for submission: ${submissionId}`;
      console.error("LeetCode GitHub Sync:", msg);
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

  if (message.type === "CONNECT_GOOGLE_SHEETS") {
    connectGoogleSheets().then(sendResponse);
    return true;
  }

  if (message.type === "TOGGLE_GOOGLE_SHEETS") {
    if (message.enable) {
      connectGoogleSheets().then(sendResponse);
    } else {
      disableGoogleSheets().then(() => sendResponse({ ok: true, enabled: false }));
    }
    return true;
  }

  if (message.type === "DISCONNECT_GOOGLE_SHEETS") {
    disconnectGoogleSheets().then(() => sendResponse({ disconnected: true }));
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

let githubDeviceFlowCancelRequested = false;

async function requestGithubDeviceCode() {
  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "repo" }),
  });
  if (!response.ok) throw new Error(`Failed to start GitHub sign-in (${response.status}).`);
  return response.json(); // { device_code, user_code, verification_uri, expires_in, interval }
}

// Polls GitHub every `interval` seconds until the user approves on
// github.com/login/device, the code expires, or the user cancels from the
// popup. "authorization_pending" is the expected/normal response while
// waiting — it is NOT an error.
async function pollGithubAccessToken(deviceCode, interval, expiresIn) {
  const deadline = Date.now() + expiresIn * 1000;
  let waitSeconds = interval;

  while (Date.now() < deadline) {
    if (githubDeviceFlowCancelRequested) throw new Error("__CANCELLED__");

    await new Promise((r) => setTimeout(r, waitSeconds * 1000));
    if (githubDeviceFlowCancelRequested) throw new Error("__CANCELLED__");

    const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = await response.json();

    if (data.access_token) return data.access_token;
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { waitSeconds += data.interval || 5; continue; }
    if (data.error === "expired_token") throw new Error("Code expired — click Connect to try again.");
    if (data.error === "access_denied") throw new Error("Authorization was denied on GitHub.");
    throw new Error(data.error_description || data.error || "GitHub sign-in failed.");
  }
  throw new Error("Code expired — click Connect to try again.");
}

function cancelGithubDeviceFlow() {
  githubDeviceFlowCancelRequested = true;
}

async function connectGithubViaDeviceFlow() {
  githubDeviceFlowCancelRequested = false;
  try {
    const { device_code, user_code, verification_uri, expires_in, interval } = await requestGithubDeviceCode();

    // Popup may not be open yet when this fires — that's fine, it also
    // re-checks GET_GITHUB_CONNECTION_STATE and the code itself is short-lived
    // anyway (typically 15 min), so a closed popup just means the user
    // re-opens it and clicks Connect again.
    chrome.runtime
      .sendMessage({ type: "GITHUB_DEVICE_CODE", user_code, verification_uri, expires_in })
      .catch(() => {});

    const accessToken = await pollGithubAccessToken(device_code, interval, expires_in);

    const userResponse = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" },
    });
    const userData = userResponse.ok ? await userResponse.json() : {};

    await chrome.storage.local.set({
      githubToken: accessToken,
      githubUsername: userData.login || null,
      githubAuthMethod: "oauth",
    });

    chrome.runtime
      .sendMessage({ type: "GITHUB_DEVICE_FLOW_RESULT", ok: true, username: userData.login || null })
      .catch(() => {});
  } catch (err) {
    if (err.message === "__CANCELLED__") {
      chrome.runtime.sendMessage({ type: "GITHUB_DEVICE_FLOW_RESULT", ok: false, cancelled: true }).catch(() => {});
      return;
    }
    console.error("GitHub Device Flow failed:", err);
    chrome.runtime
      .sendMessage({ type: "GITHUB_DEVICE_FLOW_RESULT", ok: false, message: err.message || String(err) })
      .catch(() => {});
  }
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

function cancelHistoryImport() {
  historyImportCancelRequested = true;
}

async function startHistoryImport() {
  const { githubToken, githubRepo } = await chrome.storage.local.get(["githubToken", "githubRepo"]);
  let state = await getHistoryImportState();

  if (state.status === "running") {
    console.log("History import already running — ignoring duplicate start.");
    return;
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

async function updateReadme(owner, repo, token) {
  try {
    const response = await githubRequest(
      `/repos/${owner}/${repo}/contents/${encodeGithubPath(README_PATH)}`, "GET", null, token
    );
    if (response.status === 404) {
      console.log("No README.md found in the repo — skipping stats update.");
      return;
    }
    if (!response.ok) throw new Error(`Failed to fetch README: ${response.status}`);

    const data = await response.json();
    const currentContent = fromBase64(data.content);

    const folderCounts = await getFolderCounts(owner, repo, token);
    const { leetcodeUsername } = await chrome.storage.local.get(["leetcodeUsername"]);

    let updated = currentContent;
    updated = replaceMarkerSection(updated, "AUTO-TOPICS", buildTopicsChecklist(folderCounts));
    updated = replaceMarkerSection(updated, "AUTO-STATS", buildStatsTable(folderCounts));
    updated = applyStatsCardUsername(updated, leetcodeUsername);

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
const SHEET_HEADER_ROW = ["Problem ID", "Title", "Difficulty", "Topics", "Language", "Date Solved", "LeetCode Link"];

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
    return { ok: true, spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` };
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

async function disconnectGoogleSheets() {
  await chrome.storage.local.remove(["sheetsSpreadsheetId", "sheetsEnabled"]);
  try {
    const token = await getGoogleAuthToken({ interactive: false });
    chrome.identity.removeCachedAuthToken({ token });
  } catch {
    // No cached token to remove — fine.
  }
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

async function syncProblemToSheet(titleSlug, question, langName) {
  try {
    const { sheetsSpreadsheetId, sheetsEnabled } = await chrome.storage.local.get(["sheetsSpreadsheetId", "sheetsEnabled"]);
    if (!sheetsEnabled || !sheetsSpreadsheetId) return; // user hasn't turned this on — nothing to do, not an error

    const token = await getGoogleAuthToken({ interactive: false });
    const frontendId = question.questionFrontendId;
    const row = [
      frontendId,
      question.title,
      question.difficulty || "",
      (question.topicTags || []).map((t) => t.name).join(", "),
      langName,
      new Date().toISOString().split("T")[0],
      `https://leetcode.com/problems/${titleSlug}/`,
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
      await syncProblemToSheet(titleSlug, question, langName);
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