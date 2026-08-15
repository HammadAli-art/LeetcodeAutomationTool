// This file runs INSIDE LeetCode's own page (not the isolated extension world).
// Its only job: watch network requests, and if one shows "Accepted", tell the
// content script via postMessage (the only way to cross from page -> extension).

(function () {
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;

      // LeetCode polls this endpoint after you hit Submit, until it has a result.
      if (url && url.includes("/submissions/detail/") && url.includes("/check/")) {
        response
          .clone()
          .json()
          .then((data) => {
            if (data.state === "SUCCESS" && data.status_msg === "Accepted") {
              window.postMessage(
                { source: "leetcode-github-sync", type: "ACCEPTED", payload: data },
                "*"
              );
            }
          })
          .catch(() => {
            // Not JSON, or unrelated response shape — ignore silently.
          });
      }
    } catch (e) {
      // Never let our interceptor break LeetCode's own functionality.
    }

    return response;
  };

  console.log("LeetCode GitHub Sync: fetch interceptor installed.");
})();