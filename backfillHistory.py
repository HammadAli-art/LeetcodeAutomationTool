"""
LeetCode Full History Backfill — run to (re)build everything from scratch
----------------------------------------------------------------------------
Walks your ENTIRE LeetCode submission history, finds every unique accepted
problem (deduped by title_slug), and saves + commits + pushes each one
using the new FLAT folder structure (config.json's folder_priority list).

IMPORTANT: Run this AFTER wiping the old "LeetCode Problems" folder and
deleting pushed_problems.json, so you get a clean, consistent rebuild.

Usage:
    python backfillHistory.py
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

    tracked[title_slug] = {
        "title": title,
        "timestamp": sub.get("timestamp"),
        "difficulty": difficulty,
        "tags": tag_names,
        "folder": folder_label,
    }
    save_tracked(tracked)
    return True


def main():
    print("Fetching your full accepted submission history — this may take a minute...")
    accepted = fetch_all_accepted_submissions()
    print(f"\nFound {len(accepted)} unique solved problems total.\n")

    tracked = load_tracked()
    new_files = []

    for slug, sub in accepted.items():
        try:
            saved = process_backfill_item(slug, sub, tracked)
            if saved:
                new_files.append(slug)
        except requests.RequestException as e:
            print(f"  Request failed for {slug}: {e}")

    print(f"\nBackfilled {len(new_files)} new problems.")

    if new_files:
        print("Updating README and pushing everything in one commit...")
        update_readme(tracked)
        subprocess.run(["git", "add", "."], cwd=REPO_ROOT, check=True)
        git_commit_and_push([], f"Rebuild: backfill {len(new_files)} solved problems (flat folders)")
    else:
        print("Nothing new to push.")


if __name__ == "__main__":
    main()