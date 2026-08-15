// This runs INSIDE the LeetCode page, in the EXTENSION's isolated world.
// It listens for the message that injected.js sends when it detects an
// Accepted submission, and relays it to the background service worker.

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== "leetcode-github-sync") return;

  if (event.data.type === "ACCEPTED") {
    console.log("LeetCode GitHub Sync: Accepted submission detected!", event.data.payload);
    chrome.runtime.sendMessage({
      type: "SUBMISSION_ACCEPTED",
      payload: event.data.payload,
      url: window.location.href,
    });
  }
});

console.log("LeetCode GitHub Sync: content script loaded, listening for Accepted submissions.");