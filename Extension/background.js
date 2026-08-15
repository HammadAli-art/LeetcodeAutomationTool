// This runs in the background, independent of any specific page.
// This is where GitHub API calls will eventually happen.
console.log("LeetCode GitHub Sync: background service worker loaded.");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SUBMISSION_ACCEPTED") {
    console.log("Background received an Accepted submission:", message.payload);
    console.log("From page:", message.url);
    // TODO (next step): fetch the actual solved code + push to GitHub here.
  }
});