# EuroLeague Tiebreaker Dashboard

Live standings + automatic tiebreakers for the 2025-26 EuroLeague season.

**[→ Open the dashboard](https://YOUR-USERNAME.github.io/euroleague-tiebreaker/)**

No installs. No server. Opens straight in the browser.

---

## How to put it on GitHub Pages (takes 2 minutes)

### Step 1 — Create a repository

1. Go to [github.com](https://github.com) → sign in
2. Click **+** → **New repository**
3. Name it `euroleague-tiebreaker`
4. Click **Create repository**

### Step 2 — Upload the file

1. On the empty repo page click **uploading an existing file**
2. Drag in `index.html` (that's the only file you need)
3. Click **Commit changes**

### Step 3 — Turn on GitHub Pages

1. Go to **Settings** → **Pages** (left sidebar)
2. Under *Branch*, select **main** and click **Save**
3. Wait ~30 seconds, then your dashboard is live at:
   `https://YOUR-USERNAME.github.io/euroleague-tiebreaker/`

---

## How it works

- Fetches live XML from the official Euroleague API on load
- Parses all played games, builds standings, finds tied teams
- Computes head-to-head records and point differential for each tied group
- Everything runs in the browser — no Python, no server, no database

## Tiebreaker rules

When teams are tied on wins:
1. More wins in head-to-head games between the tied teams
2. Better point differential in those same games

---

## Attendance & Referees tabs

Two extra tabs sit next to the tiebreaker view, each with a season selector (2021–22 to the current season) and a regular-season / playoffs filter.

- **Attendance** – totals, averages, max/min and "average as % of max" per home team, plus the ten biggest crowds.
- **Referees** – games per referee, home-win %, average total points and margin in the games they worked, a search box, a "Lithuanian referees only" filter and a click-to-expand game list.

Data lives in `data/<season>.json` (built from the official boxscore API with `scripts/scrape.py`). For the current season the page also checks the Euroleague API every time it is opened (or Refresh is clicked) and fetches any finished game that is missing from the snapshot, so new games show up without any redeploy. Re-run `python scripts/scrape.py E2026` now and then to refresh the snapshot.

To undo this feature: revert the merge commit, or `git reset --hard pre-attendance-tabs` (tag marking the site as it was before).
