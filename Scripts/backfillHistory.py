"""
LeetCode Full History Backfill
----------------------------------------------------------------------------
Walks your ENTIRE LeetCode submission history, finds every unique accepted
problem (deduped by title_slug), and saves + commits + pushes each one that
ISN'T ALREADY in pushed_problems.json using the flat folder structure
(config.json's folder_priority list).

NOTE: this does NOT touch problems already tracked — it only picks up ones
that are missing. For a genuine full rebuild, first delete/reset the
"LeetCode Problems" folder AND pushed_problems.json, then run this.
"""

import time
import subprocess
import requests

from leetcodePoller import (
    HEADERS,
    save_solution_file,
    fetch_question_details,
    update_readme,
    git_commit_and_push,
    load_tracked,
    save_tracked,
    REPO_ROOT,
    SessionExpiredError,
)

SUBMISSIONS_API = "https://leetcode.com/api/submissions/"


def fetch_all_accepted_submissions():
    offset = 0
    limit = 20
    seen_slugs = {}
    page = 1

    while True:
        url = f"{SUBMISSIONS_API}?offset={offset}&limit={limit}"
        resp = requests.get(url, headers=HEADERS, timeout=20)
        if resp.status_code == 401:
            raise SessionExpiredError(
                "LeetCode rejected the session — your LEETCODE_SESSION/LEETCODE_CSRF "
                "have likely expired. Get fresh values from DevTools (Application -> "
                "Cookies -> leetcode.com) and set the env vars again."
            )
        resp.raise_for_status()
        data = resp.json()

        dump = data.get("submissions_dump", [])
        print(f"Page {page}: got {len(dump)} submissions (offset={offset})")

        if not dump:
            break

        for sub in dump:
            if sub.get("status_display") != "Accepted":
                continue
            slug = sub.get("title_slug")
            if not slug:
                continue
            if slug not in seen_slugs:
                seen_slugs[slug] = sub

        if not data.get("has_next"):
            break

        offset += limit
        page += 1
        time.sleep(1)

    return seen_slugs


def process_backfill_item(title_slug, sub, tracked):
    if title_slug in tracked:
        return False  # already have this problem, skip

    title = sub.get("title")
    code = sub.get("code")
    lang_name = sub.get("lang")

    if not code:
        print(f"  Skipping {title}: no code in dump.")
        return False

    print(f"Backfilling: {title}")

    question = fetch_question_details(title_slug)
    if not question:
        print(f"  Could not fetch question details for {title}, skipping.")
        return False

    frontend_id = question["questionFrontendId"]
    difficulty = question.get("difficulty")
    topic_tags = question.get("topicTags", [])
    tag_names = [t["name"] for t in topic_tags]

    file_path, folder_label = save_solution_file(frontend_id, title, code, lang_name, topic_tags)
    print(f"  Saved to: {file_path}")

    # NOTE: we only update the in-memory 'tracked' dict here — we do NOT
    # call save_tracked() yet. The actual disk save happens once in main(),
    # and ONLY if the final git push succeeds. This prevents problems being
    # marked "done" if the push fails partway through a large backfill.
    tracked[title_slug] = {
        "title": title,
        "timestamp": sub.get("timestamp"),
        "difficulty": difficulty,
        "tags": tag_names,
        "folder": folder_label,
        "file_path": file_path,
    }
    return file_path


def check_working_tree_clean():
    """Refuses to run if there are unrelated uncommitted changes already
    sitting in the repo — avoids accidentally sweeping them into a backfill
    commit/push."""
    result = subprocess.run(
        ["git", "status", "--porcelain"], cwd=REPO_ROOT, capture_output=True, text=True, check=True
    )
    return len(result.stdout.strip()) == 0


def main():
    if not check_working_tree_clean():
        print("ERROR: Your repo has uncommitted changes already. Please commit or "
              "stash them first, then re-run this script — this avoids accidentally "
              "sweeping unrelated files into the backfill commit.")
        return

    print("Fetching your full accepted submission history — this may take a minute...")
    try:
        accepted = fetch_all_accepted_submissions()
    except SessionExpiredError as e:
        print(f"\nSTOPPED: {e}\n")
        return
    print(f"\nFound {len(accepted)} unique solved problems total.\n")

    tracked = load_tracked()
    new_file_paths = []

    for slug, sub in accepted.items():
        try:
            result = process_backfill_item(slug, sub, tracked)
            if result:
                new_file_paths.append(result)
        except SessionExpiredError as e:
            print(f"\nSTOPPED mid-backfill: {e}")
            print(f"Progress so far ({len(new_file_paths)} problems) will still be pushed below.\n")
            break
        except requests.RequestException as e:
            print(f"  Request failed for {slug}: {e}")

    print(f"\nBackfilled {len(new_file_paths)} new problems.")

    if new_file_paths:
        print("Updating README and pushing...")
        readme_path = update_readme(tracked)

        paths_to_commit = list(new_file_paths)
        if readme_path:
            paths_to_commit.append(readme_path)

        push_succeeded = git_commit_and_push(
            paths_to_commit, f"Rebuild: backfill {len(new_file_paths)} solved problems (flat folders)"
        )

        if push_succeeded:
            save_tracked(tracked)
            print(f"Push succeeded — {len(new_file_paths)} problems saved to tracking.")
        else:
            print(f"WARNING: push failed — none of these {len(new_file_paths)} problems were "
                  f"marked as tracked. Re-run this script to retry them.")
    else:
        print("Nothing new to push.")


if __name__ == "__main__":
    main()