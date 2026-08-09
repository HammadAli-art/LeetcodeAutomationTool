# LeetCode → GitHub Auto Sync

Automatically sync your accepted LeetCode submissions to a GitHub repo —
correct topic-based folders, consistent file naming, and a self-updating
README with your solving stats. No manual copy-pasting, no manual commits.

## Why this exists

I solve LeetCode problems regularly and wanted my GitHub repo to reflect
that progress automatically — organized by topic, with a README that shows
real stats, without me manually creating folders, renaming files, or writing
commit messages every time.

This started as a personal Python script. The plan is to eventually turn
this into a **browser extension** anyone can install — so you just solve
problems on LeetCode like normal, and everything else happens in the
background, without needing Python, a terminal, or copy-pasted session
cookies.

**Current phase:** Personal Python automation (this repo).
**Next phase:** Browser extension (real-time detection, no terminal needed,
installable by anyone).

## What each file does

| File | Purpose |
|------|---------|
| `leetcodePoller.py` | The main script. Runs continuously, checks LeetCode for new accepted submissions, fetches the code, figures out the right topic folder, saves the file, updates the README, and pushes to GitHub — all automatically. |
| `backfillHistory.py` | A one-time script to import your **entire** past LeetCode solving history (not just recent submissions), so your repo reflects everything you've ever solved. |
| `renamefolder.py` | A small utility to relabel folder names in your tracked data (and refresh the README) without needing to re-fetch anything from LeetCode. |
| `config.json` | Settings — your repo path, topic-to-folder name mapping, which tags count as "generic" (e.g. Array/String), and which topics show up in the README's progress checklist. Fully customizable, no code editing needed. |
| `pushed_problems.json` | *(not committed — see `.gitignore`)* Local tracking data so the script knows which problems have already been processed. |

## How the folder organization works

Problems are organized in **nested folders** based on their LeetCode topic
tags, so no tag information is lost:

```
LeetCode Problems/
├── Array/
│   └── HashTable/
│       └── 1_Two_Sum.java
├── BinarySearch/
│   └── 704_Binary_Search.java
```

- **Level 1** folder = a "base" tag if present (e.g. `Array`, `String`)
- **Level 2** folder = all remaining tags combined (e.g. `HashTable`, or
  `HashTable_SlidingWindow` if a problem has multiple technique tags)

This mapping is fully configurable in `config.json`.

## README automation

The main README.md (in your solutions repo) auto-updates two sections,
marked with HTML comments so the rest of your README is untouched:

```
<!-- AUTO-STATS:START -->  ...  <!-- AUTO-STATS:END -->
<!-- AUTO-TOPICS:START --> ...  <!-- AUTO-TOPICS:END -->
```

## Setup

1. Install dependencies: `pip install requests`
2. Get your LeetCode session cookie and CSRF token from your browser's
   DevTools (Application → Cookies → leetcode.com)
3. Set environment variables: `LEETCODE_USERNAME`, `LEETCODE_SESSION`,
   `LEETCODE_CSRF`
4. Edit `config.json` to match your repo path and folder preferences
5. Run `python leetcodePoller.py` and leave it running while you solve
   problems

## Known limitations (being worked on)

- If you resubmit an already-solved problem, it's skipped (so your stats
  don't get inflated) — but this also means an improved/optimized solution
  won't overwrite the original one yet.
- Solving the same problem in multiple languages currently only keeps the
  first one.
- The LeetCode API used here is unofficial and undocumented, so it can
  occasionally change or fail — the script retries automatically but isn't
  bulletproof.

## Roadmap

- [x] Auto-detect accepted submissions
- [x] Auto-organize into topic folders
- [x] Auto-commit + push to GitHub
- [x] Auto-updating README with stats
- [x] Full history backfill
- [ ] Browser extension (real-time, no terminal, installable by anyone)
- [ ] Multi-language support
- [ ] Publish to Chrome Web Store
