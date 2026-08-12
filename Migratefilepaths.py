"""
Migrate pushed_problems.json — add missing "file_path" to old records
--------------------------------------------------------------------------
Old records (created before file_path tracking was added) are missing the
"file_path" key. This script finds the actual file on disk for each old
record (by scanning the folder it's tagged with) and fills it in — so that
future language-change resubmits can correctly clean up the old file.

Run this ONCE.
"""

import os
import json

from leetcodePoller import REPO_ROOT, PROBLEMS_SUBDIR, load_tracked, save_tracked, sanitize_title


def find_file_for_problem(folder_name, title_slug, tracked_title):
    """Look inside the given folder for a file matching this problem."""
    folder_path = os.path.join(REPO_ROOT, PROBLEMS_SUBDIR, folder_name)
    if not os.path.isdir(folder_path):
        return None

    expected_suffix = sanitize_title(tracked_title).lower()

    for filename in os.listdir(folder_path):
        # Filenames look like "217_Contains_Duplicate.java" — use the SAME
        # sanitize_title() logic used when the file was originally created,
        # so hyphens/apostrophes/etc. match consistently.
        name_part = filename.rsplit(".", 1)[0]
        if name_part.lower().endswith(expected_suffix):
            return os.path.join(folder_path, filename)
    return None


def main():
    tracked = load_tracked()
    migrated = 0
    not_found = 0

    for title_slug, record in tracked.items():
        if record.get("file_path"):
            continue  # already has it, skip

        folder = record.get("folder")
        title = record.get("title", "")
        if not folder:
            not_found += 1
            continue

        found_path = find_file_for_problem(folder, title_slug, title)
        if found_path:
            record["file_path"] = found_path
            migrated += 1
        else:
            print(f"  Could not locate file for: {title} (folder: {folder})")
            not_found += 1

    save_tracked(tracked)
    print(f"\nMigrated {migrated} records. {not_found} could not be matched (safe to ignore — "
          f"they'll just get file_path filled in next time they're resubmitted).")


if __name__ == "__main__":
    main()