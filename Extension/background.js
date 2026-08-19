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
  const query = `
    query submissionList($offset: Int!, $limit: Int!, $status: String) {
      submissionList(offset: $offset, limit: $limit, status: $status) {
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
  const data = await graphqlRequest(query, { offset, limit, status: "AC" });
  return data.submissionList;
}

// Shared by BOTH the live "just solved a problem" flow AND the bulk history
// import below, so the two paths can never drift out of sync with each other.
async function handleAcceptedSubmission(submissionId, titleSlug) {
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

    await pushToGitHub(titleSlug, question, code, langName);
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
});

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

        const result = await handleAcceptedSubmission(sub.id, sub.titleSlug);

        processedSet.add(sub.titleSlug);
        state.processedSlugs = Array.from(processedSet);
        if (result.ok) state.imported += 1;
        else state.failed += 1;
        await saveHistoryImportState(state);

        await new Promise((r) => setTimeout(r, HISTORY_IMPORT_DELAY_MS));
      }

      state.offset += HISTORY_IMPORT_PAGE_SIZE;
      await saveHistoryImportState(state);

      if (!page?.hasNext) break;
    }

    state.status = "completed";
    state.currentTitle = null;
    await saveHistoryImportState(state);
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

async function pushToGitHub(titleSlug, question, code, langName) {
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