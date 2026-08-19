// This file runs INSIDE LeetCode's own page (not the isolated extension world).
// Its only job: watch network requests, and if one shows "Accepted", tell the
// content script via postMessage (the only way to cross from page -> extension).

(function () {
  const originalFetch = window.fetch;
  const notifiedSubmissions = new Set();

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url;

      // NOTE: LeetCode's check endpoint is versioned as "v2" now
      // (e.g. /submissions/detail/2108716447/v2/check/).
      const match = url && url.match(/\/submissions\/detail\/(\d+)\/v2\/check/);

      if (match) {
        const submissionId = match[1];

        response
          .clone()
          .json()
          .then((data) => {
            if (data.status_code === 10 && data.status_msg === "Accepted") {
              if (notifiedSubmissions.has(submissionId)) return; // avoid duplicate firing
              notifiedSubmissions.add(submissionId);

              const slugMatch = window.location.pathname.match(/\/problems\/([a-z0-9\-]+)/);
              const titleSlug = slugMatch ? slugMatch[1] : null;

              window.postMessage(
                {
                  source: "leetcode-github-sync",
                  type: "ACCEPTED",
                  payload: data,
                  submissionId,
                  titleSlug,
                },
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