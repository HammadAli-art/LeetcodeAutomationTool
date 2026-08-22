// This runs INSIDE the LeetCode page, in the EXTENSION's isolated world.
// It listens for the message that injected.js sends when it detects an
// Accepted submission, and relays it to the background service worker.
// submissionId/titleSlug come directly from injected.js (extracted from the
// actual network request URL) — NOT parsed from window.location.href, since
// that can lag behind the real submission state.

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== "leetcode-github-sync") return;

  if (event.data.type === "ACCEPTED") {
    console.log("Kodelith: Accepted submission detected!", event.data.payload);

    if (!event.data.submissionId || !event.data.titleSlug) {
      console.log("Kodelith: missing submissionId/titleSlug, skipping.");
      return;
    }

    chrome.runtime.sendMessage({
      type: "SUBMISSION_ACCEPTED",
      payload: event.data.payload,
      submissionId: event.data.submissionId,
      titleSlug: event.data.titleSlug,
    });
  }
});

console.log("Kodelith: content script loaded, listening for Accepted submissions.");