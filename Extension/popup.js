console.log("LeetCode GitHub Sync: popup loaded.");

const tokenInput = document.getElementById("token");
const repoInput = document.getElementById("repo");
const saveBtn = document.getElementById("saveBtn");
const statusDiv = document.getElementById("status");

// Load any previously saved settings when the popup opens.
chrome.storage.local.get(["githubToken", "githubRepo"], (result) => {
  if (result.githubToken) tokenInput.value = result.githubToken;
  if (result.githubRepo) repoInput.value = result.githubRepo;
});

saveBtn.addEventListener("click", () => {
  const githubToken = tokenInput.value.trim();
  const githubRepo = repoInput.value.trim();

  if (!githubToken || !githubRepo) {
    statusDiv.style.color = "red";
    statusDiv.textContent = "Please fill in both fields.";
    return;
  }

  chrome.storage.local.set({ githubToken, githubRepo }, () => {
    statusDiv.style.color = "green";
    statusDiv.textContent = "Saved!";
  });
});