"""
LeetCode Accepted Submission Poller — v0.5
--------------------------------------------
What's new in this version:
1. FLAT folders: one problem = one folder, chosen by an ordered priority
   list in config.json (e.g. Array beats Binary Search/Sorting/etc — a
   data-structure tag always wins over a technique tag).
2. RESUBMIT support: if you solve a problem again (e.g. a better solution),
   the old file is overwritten and a "Resubmit X. Title" commit is made —
   it no longer gets silently skipped.

SETUP: env vars (LEETCODE_USERNAME, LEETCODE_SESSION, LEETCODE_CSRF),
config.json in the same folder.
"""

import os
import re
import json
import time
import subprocess
import requests

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

CONFIG_FILE = "config.json"


def load_config():
    if not os.path.exists(CONFIG_FILE):
        raise FileNotFoundError(
            f"'{CONFIG_FILE}' not found in this folder. Make sure config.json "
            f"is in the same directory as leetcodePoller.py before running."
        )
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


CONFIG = load_config()

LEETCODE_SESSION = os.environ.get("LEETCODE_SESSION", "")
CSRF_TOKEN = os.environ.get("LEETCODE_CSRF", "")
LEETCODE_USERNAME = os.environ.get("LEETCODE_USERNAME", "")

POLL_INTERVAL_SECONDS = 120
TRACKED_FILE = "pushed_problems.json"

REPO_ROOT = CONFIG["repo_root"]
PROBLEMS_SUBDIR = CONFIG["problems_subdir"]
DEFAULT_FOLDER = CONFIG["default_folder"]
FOLDER_PRIORITY = CONFIG["folder_priority"]
README_TOPICS = CONFIG.get("readme_topics", [])

GRAPHQL_URL = "https://leetcode.com/graphql"

HEADERS = {
    "Content-Type": "application/json",
    "Referer": "https://leetcode.com",
    "Cookie": f"LEETCODE_SESSION={LEETCODE_SESSION}; csrftoken={CSRF_TOKEN}",
    "x-csrftoken": CSRF_TOKEN,
}

# ---------------------------------------------------------------------------
# GraphQL queries
# ---------------------------------------------------------------------------

RECENT_AC_QUERY = """
query recentAcSubmissions($username: String!, $limit: Int!) {
  recentAcSubmissionList(username: $username, limit: $limit) {
    id
    title
    titleSlug
    timestamp
    lang
  }
}
"""

SUBMISSION_DETAILS_QUERY = """
query submissionDetails($submissionId: Int!) {
  submissionDetails(submissionId: $submissionId) {
    code
    lang {
      name
    }
  }
}
"""

QUESTION_DETAILS_QUERY = """
query questionData($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionFrontendId
    title
    difficulty
    topicTags {
      name
    }
  }
}
"""

# ---------------------------------------------------------------------------
# Tracking — keyed by title_slug (one entry per PROBLEM)
# ---------------------------------------------------------------------------


def load_tracked():
    if os.path.exists(TRACKED_FILE):
        with open(TRACKED_FILE, "r") as f:
            return json.load(f)
    return {}


def save_tracked(data):
    with open(TRACKED_FILE, "w") as f:
        json.dump(data, f, indent=2)


# ---------------------------------------------------------------------------
# LeetCode API calls
# ---------------------------------------------------------------------------


class SessionExpiredError(Exception):
    """Raised when LeetCode rejects our session cookie (expired/invalid)."""
    pass


def graphql_request(query: str, variables: dict, retries: int = 2):
    payload = {"query": query, "variables": variables}
    last_error = None
    for attempt in range(retries + 1):
        try:
            resp = requests.post(GRAPHQL_URL, json=payload, headers=HEADERS, timeout=20)
            if resp.status_code == 401:
                raise SessionExpiredError(
                    "LeetCode rejected the session — your LEETCODE_SESSION/LEETCODE_CSRF "
                    "have likely expired. Get fresh values from DevTools (Application -> "
                    "Cookies -> leetcode.com) and set the env vars again."
                )
            resp.raise_for_status()
            return resp.json().get("data", {})
        except SessionExpiredError:
            raise  # don't retry — a fresh cookie is needed, retrying won't help
        except requests.RequestException as e:
            last_error = e
            if attempt < retries:
                print(f"  Request failed ({e}), retrying...")
                time.sleep(3)
    raise last_error


def fetch_recent_accepted(username: str, limit: int = 15):
    data = graphql_request(RECENT_AC_QUERY, {"username": username, "limit": limit})
    return data.get("recentAcSubmissionList", [])


def fetch_submission_code(submission_id: str):
    data = graphql_request(SUBMISSION_DETAILS_QUERY, {"submissionId": int(submission_id)})
    details = data.get("submissionDetails")
    if not details:
        return None, None
    return details.get("code"), details.get("lang", {}).get("name")


def fetch_question_details(title_slug: str):
    data = graphql_request(QUESTION_DETAILS_QUERY, {"titleSlug": title_slug})
    return data.get("question")


# ---------------------------------------------------------------------------
# Flat folder logic (priority list)
# ---------------------------------------------------------------------------


def determine_folder(topic_tags):
    if not topic_tags:
        return DEFAULT_FOLDER

    tag_names = {t["name"] for t in topic_tags}

    for entry in FOLDER_PRIORITY:
        if tag_names.intersection(entry["tags"]):
            return entry["folder"]

    return DEFAULT_FOLDER


# ---------------------------------------------------------------------------
# File saving
# ---------------------------------------------------------------------------


def sanitize_title(title: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9\s]", "", title)
    return "_".join(cleaned.split())


LANG_EXTENSION = {
    "java": "java",
    "python3": "py",
    "python": "py",
    "c++": "cpp",
    "cpp": "cpp",
    "javascript": "js",
    "c": "c",
    "c#": "cs",
    "csharp": "cs",
    "go": "go",
    "kotlin": "kt",
    "swift": "swift",
    "typescript": "ts",
}


def save_solution_file(frontend_id, title, code, lang_name, topic_tags):
    lang_key = (lang_name or "").lower()
    ext = LANG_EXTENSION.get(lang_key, "txt")
    if ext == "txt":
        print(f"  NOTE: unrecognized language '{lang_name}', saved as .txt.")

    folder_name = determine_folder(topic_tags)
    folder_path = os.path.join(REPO_ROOT, PROBLEMS_SUBDIR, folder_name)
    os.makedirs(folder_path, exist_ok=True)

    filename = f"{frontend_id}_{sanitize_title(title)}.{ext}"
    file_path = os.path.join(folder_path, filename)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(code)

    return file_path, folder_name


# ---------------------------------------------------------------------------
# README auto-update
# ---------------------------------------------------------------------------


def replace_between_markers(content: str, marker_name: str, new_inner: str):
    start = f"<!-- {marker_name}:START -->"
    end = f"<!-- {marker_name}:END -->"
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.DOTALL)
    replacement = f"{start}\n{new_inner}\n{end}"
    if pattern.search(content):
        return pattern.sub(replacement, content), True
    print(f"  NOTE: markers for '{marker_name}' not found in README.md.")
    return content, False


def build_stats_block(tracked: dict) -> str:
    from collections import Counter

    total = len(tracked)
    folder_counts = Counter(v.get("folder", "Unknown") for v in tracked.values())

    lines = [f"**Total Solved:** {total}", "", "| Topic | Solved |", "|-------|--------|"]
    for folder, count in sorted(folder_counts.items(), key=lambda x: -x[1]):
        lines.append(f"| {folder} | {count} |")
    return "\n".join(lines)


def build_topics_block(tracked: dict) -> str:
    solved_tags = set()
    for v in tracked.values():
        solved_tags.update(v.get("tags", []))

    lines = []
    for item in README_TOPICS:
        checked = any(tag in solved_tags for tag in item["tags"])
        box = "x" if checked else " "
        lines.append(f"- [{box}] {item['label']}")
    return "\n".join(lines)


def update_readme(tracked: dict):
    readme_path = os.path.join(REPO_ROOT, "README.md")
    if not os.path.exists(readme_path):
        print("  README.md not found at repo root, skipping README update.")
        return None

    with open(readme_path, "r", encoding="utf-8") as f:
        content = f.read()

    content, stats_ok = replace_between_markers(content, "AUTO-STATS", build_stats_block(tracked))
    content, topics_ok = replace_between_markers(content, "AUTO-TOPICS", build_topics_block(tracked))

    if not (stats_ok or topics_ok):
        return None

    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(content)

    return readme_path


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------


def git_commit_and_push(file_paths, commit_message, max_push_attempts=2):
    """Returns True if the push succeeded, False otherwise."""
    try:
        for path in file_paths:
            subprocess.run(["git", "add", path], cwd=REPO_ROOT, check=True)

        commit_result = subprocess.run(
            ["git", "commit", "-m", commit_message],
            cwd=REPO_ROOT, capture_output=True, text=True
        )
        if commit_result.returncode != 0:
            if "nothing to commit" in commit_result.stdout.lower():
                print("  Nothing new to commit — will still try to push.")
            else:
                print(f"  Commit warning: {commit_result.stdout.strip()} {commit_result.stderr.strip()}")

        for attempt in range(max_push_attempts):
            push_result = subprocess.run(
                ["git", "push"], cwd=REPO_ROOT, capture_output=True, text=True
            )
            if push_result.returncode == 0:
                print(f"Pushed: {commit_message}")
                return True

            stderr_lower = push_result.stderr.lower()
            is_rejected = any(
                phrase in stderr_lower
                for phrase in ["rejected", "fetch first", "non-fast-forward"]
            )

            if is_rejected and attempt < max_push_attempts - 1:
                print("  Push rejected (remote has new commits) — pulling and retrying...")
                pull_result = subprocess.run(
                    ["git", "pull", "--no-edit"], cwd=REPO_ROOT, capture_output=True, text=True
                )
                if pull_result.returncode != 0:
                    if "CONFLICT" in pull_result.stdout or "CONFLICT" in pull_result.stderr:
                        print("  MERGE CONFLICT during auto-pull — aborting, needs manual fix.")
                        subprocess.run(["git", "merge", "--abort"], cwd=REPO_ROOT)
                    else:
                        print(f"  Auto-pull failed: {pull_result.stderr.strip()}")
                    return False
                # merge succeeded, loop again to retry the push
                continue
            else:
                print(f"  Push failed: {push_result.stderr.strip()}")
                return False

        print("  Push still failing after retry.")
        return False

    except subprocess.CalledProcessError as e:
        print(f"Git step failed: {e}")
        return False


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def process_submission(sub, tracked):
    title = sub["title"]
    title_slug = sub["titleSlug"]
    submission_id = sub["id"]

    is_resubmit = title_slug in tracked
    old_file_path = tracked.get(title_slug, {}).get("file_path")

    if is_resubmit:
        print(f"RESUBMIT DETECTED: {title} — updating existing solution...")
    else:
        print(f"NEW ACCEPTED: {title} — fetching code and metadata...")

    code, lang_name = fetch_submission_code(submission_id)
    if not code:
        print(f"  Could not fetch code for {title}, will retry next cycle.")
        return None

    question = fetch_question_details(title_slug)
    if not question:
        print(f"  Could not fetch question details for {title}, will retry next cycle.")
        return None

    frontend_id = question["questionFrontendId"]
    difficulty = question.get("difficulty")
    topic_tags = question.get("topicTags", [])
    tag_names = [t["name"] for t in topic_tags]

    file_path, folder_label = save_solution_file(frontend_id, title, code, lang_name, topic_tags)
    print(f"  Saved to: {file_path}")

    # If the language changed since the last submission (e.g. C++ -> Java),
    # the filename/extension is different — remove the old file so we don't
    # end up with two files for the same problem.
    if old_file_path and old_file_path != file_path and os.path.exists(old_file_path):
        os.remove(old_file_path)
        print(f"  Removed old file (language changed): {old_file_path}")

    record = {
        "title": title,
        "timestamp": sub["timestamp"],
        "difficulty": difficulty,
        "tags": tag_names,
        "folder": folder_label,
        "file_path": file_path,
    }

    # NOTE: we build the README diff using a temporary in-memory copy of
    # tracked + this new record, WITHOUT saving it to disk yet — so that if
    # the git push below fails, pushed_problems.json is left untouched and
    # this problem will be retried on the next poll cycle instead of being
    # silently marked "done" forever.
    tentative_tracked = dict(tracked)
    tentative_tracked[title_slug] = record

    readme_path = update_readme(tentative_tracked)
    paths_to_commit = [file_path]
    if readme_path:
        paths_to_commit.append(readme_path)
        print("  README.md updated.")

    if old_file_path and old_file_path != file_path and not os.path.exists(old_file_path):
        paths_to_commit.append(old_file_path)

    action_word = "Resubmit" if is_resubmit else "Solve"
    commit_message = f"{action_word} {frontend_id}. {title}"
    push_succeeded = git_commit_and_push(paths_to_commit, commit_message)

    if push_succeeded:
        tracked[title_slug] = record
        save_tracked(tracked)
    else:
        print(f"  WARNING: push failed — '{title}' will be retried next cycle "
              f"(not marked as done).")
        return None

    return record


def main():
    if not (LEETCODE_SESSION and CSRF_TOKEN and LEETCODE_USERNAME):
        print("ERROR: Set LEETCODE_USERNAME, LEETCODE_SESSION, and LEETCODE_CSRF env vars first.")
        return

    tracked = load_tracked()
    print(f"Polling started: checking every {POLL_INTERVAL_SECONDS}s...")

    while True:
        try:
            recent = fetch_recent_accepted(LEETCODE_USERNAME)
            # Process ALL recent accepted submissions (not just untracked ones)
            # so resubmits are caught too — process_submission decides new vs resubmit.
            seen_this_cycle = set()
            new_activity = False

            for sub in recent:
                if sub["titleSlug"] in seen_this_cycle:
                    continue  # avoid double-processing same problem twice in one cycle
                seen_this_cycle.add(sub["titleSlug"])

                existing = tracked.get(sub["titleSlug"])
                # Only reprocess if this is a brand-new problem, OR the submission
                # timestamp is newer than what we already recorded (a real resubmit).
                if existing and existing.get("timestamp") == sub["timestamp"]:
                    continue  # same submission we've already handled

                process_submission(sub, tracked)
                new_activity = True

            if not new_activity:
                print("No new submissions found.")

        except SessionExpiredError as e:
            print(f"\nSTOPPED: {e}\n")
            break
        except requests.RequestException as e:
            print(f"Request failed: {e}")

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()