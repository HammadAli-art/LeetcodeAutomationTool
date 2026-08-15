"""
Quick Folder Rename Fix — run ONCE
--------------------------------------------
Fixes old folder labels in pushed_problems.json (e.g. "BasicArrayTraversal"
-> "Array") WITHOUT re-fetching anything from LeetCode. Then refreshes the
README stats/checklist and pushes just that change.

Usage:
    python renamefolder.py
"""

from leetcodePoller import load_tracked, save_tracked, update_readme, git_commit_and_push, REPO_ROOT

# Edit this mapping to whatever renames you need (old_name -> new_name)
RENAMES = {
    "BasicArrayTraversal": "Array",
}


def apply_renames(tracked):
    changed = 0
    for slug, record in tracked.items():
        folder = record.get("folder", "")
        for old, new in RENAMES.items():
            if old in folder:
                record["folder"] = folder.replace(old, new)
                changed += 1
                break
    return changed


def main():
    tracked = load_tracked()
    changed = apply_renames(tracked)
    print(f"Updated {changed} tracked records.")

    if changed == 0:
        print("Nothing to rename, exiting.")
        return

    save_tracked(tracked)
    readme_path = update_readme(tracked)

    if readme_path:
        git_commit_and_push([readme_path], "Rename folder labels in README stats")
    else:
        print("README not updated (markers missing?), tracked data still saved locally.")


if __name__ == "__main__":
    main()