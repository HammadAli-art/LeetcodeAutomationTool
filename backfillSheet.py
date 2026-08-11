"""
Backfill Google Sheet — run ONCE
--------------------------------------------
Scans every solution file currently in your "LeetCode Problems" folder
(regardless of how/when it was committed) and logs each one to your
Google Sheet, using each file's first commit date.

SETUP (env vars):
    set REPO_ROOT=C:\\Users\\Hammad\\Documents\\JAVA\\DSACodingPractice
    set GITHUB_REPO=HammadAli-art/Java-DSA
    set SHEET_ID=your_sheet_id
    set GOOGLE_CREDS_FILE=C:\\path\\to\\your\\downloaded-service-account.json

Usage:
    python backfillSheet.py
"""

import os
import re
import json
import subprocess
from datetime import datetime
from zoneinfo import ZoneInfo
from urllib.parse import quote

import gspread
from google.oauth2.service_account import Credentials

KARACHI = ZoneInfo("Asia/Karachi")
FILENAME_PATTERN = re.compile(r"^(\d+)_(.+)\.\w+$")

REPO_ROOT = os.environ["REPO_ROOT"]
GITHUB_REPO = os.environ["GITHUB_REPO"]
SHEET_ID = os.environ["SHEET_ID"]
GOOGLE_CREDS_FILE = os.environ["GOOGLE_CREDS_FILE"]
BRANCH = os.environ.get("BRANCH", "master")
PROBLEMS_SUBDIR = os.environ.get("PROBLEMS_SUBDIR", "LeetCode Problems")


def get_first_commit_date(relative_path):
    """Returns the ISO date of the FIRST commit that introduced this file."""
    result = subprocess.run(
        ["git", "log", "--follow", "--format=%aI", "--", relative_path],
        cwd=REPO_ROOT, capture_output=True, text=True, check=True,
    )
    dates = result.stdout.strip().splitlines()
    if not dates:
        return None
    return dates[-1]  # last line = oldest commit (git log is newest-first)


def scan_solution_files():
    problems_root = os.path.join(REPO_ROOT, PROBLEMS_SUBDIR)
    problems = []

    for dirpath, _, filenames in os.walk(problems_root):
        for filename in filenames:
            match = FILENAME_PATTERN.match(filename)
            if not match:
                continue

            number, title = match.group(1), match.group(2)
            full_path = os.path.join(dirpath, filename)
            relative_path = os.path.relpath(full_path, REPO_ROOT).replace("\\", "/")

            date_iso = get_first_commit_date(relative_path)
            if date_iso:
                commit_dt = datetime.fromisoformat(date_iso).astimezone(KARACHI)
                date_str = commit_dt.strftime("%Y-%m-%d")
                day_str = commit_dt.strftime("%A")
            else:
                date_str, day_str = "Unknown", "Unknown"

            topic_path = relative_path.split(f"{PROBLEMS_SUBDIR}/")[-1]
            topic = "/".join(topic_path.split("/")[:-1]) or "Unknown"

            github_url = f"https://github.com/{GITHUB_REPO}/blob/{BRANCH}/{quote(relative_path)}"

            problems.append({
                "number": number,
                "title": title.replace("_", " "),
                "topic": topic,
                "url": github_url,
                "date": date_str,
                "day": day_str,
            })

    return problems


def log_to_sheet(problems):
    with open(GOOGLE_CREDS_FILE, "r", encoding="utf-8") as f:
        creds_info = json.load(f)

    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_info(creds_info, scopes=scopes)
    client = gspread.authorize(creds)
    sheet = client.open_by_key(SHEET_ID).sheet1

    number_column = sheet.col_values(3)  # column C = Problem Number

    rows_to_append = []
    updated_count = 0

    for p in problems:
        link_formula = f'=HYPERLINK("{p["url"]}", "{p["title"]}")'
        row_values = [p["date"], p["day"], p["number"], link_formula, p["topic"]]

        existing_row_index = None
        for i, value in enumerate(number_column, start=1):
            if value.strip() == p["number"]:
                existing_row_index = i
                break

        if existing_row_index:
            sheet.update(
                f"A{existing_row_index}:E{existing_row_index}",
                [row_values],
                value_input_option="USER_ENTERED",
            )
            updated_count += 1
        else:
            rows_to_append.append(row_values)
            # Also track it locally so two new problems in this same run
            # don't collide with each other and both get appended correctly.
            number_column.append(p["number"])

    if rows_to_append:
        sheet.append_rows(rows_to_append, value_input_option="USER_ENTERED")

    print(f"  {len(rows_to_append)} new row(s) added, {updated_count} existing row(s) updated.")


def main():
    print("Scanning solution files...")
    problems = scan_solution_files()
    print(f"Found {len(problems)} solution files.")

    if not problems:
        print("Nothing to log.")
        return

    problems.sort(key=lambda p: p["date"])

    log_to_sheet(problems)
    print(f"Logged {len(problems)} rows to the Google Sheet.")


if __name__ == "__main__":
    main()