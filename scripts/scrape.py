"""Rebuild the attendance/referee snapshots in data/<season>.json.

Usage (from the repo root):  python scripts/scrape.py E2026 [E2025 ...]
Existing games are kept; only finished games missing from the file are fetched.
The website tops up the current season live in the browser, so this only needs to be
re-run occasionally to keep the snapshot fresh.
Requires: pip install requests
"""
import datetime, json, os, sys
from concurrent.futures import ThreadPoolExecutor
import requests

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")


def get_json(url, params=None):
    for _ in range(4):
        try:
            r = requests.get(url, params=params, timeout=30)
            if r.status_code == 200:
                return r.json()
        except requests.RequestException:
            pass
    return None


def parse_refs(raw):
    parts = [p.strip() for p in (raw or "").split(",") if p.strip() and p.strip() not in ("N/D", "N/A")]
    refs = [", ".join(parts[i:i + 2]) for i in range(0, len(parts), 2)]
    return (refs + ["", "", ""])[:3]


def run(season):
    path = os.path.join(ROOT, season + ".json")
    prev = {}
    if os.path.exists(path):
        prev = {r[0]: r for r in json.load(open(path))["games"]}
    feed = get_json(f"https://api-live.euroleague.net/v2/competitions/E/seasons/{season}/games")["data"]
    games = [g for g in feed if g["played"] and not g["local"]["club"]["isVirtual"] and not g["road"]["club"]["isVirtual"]]
    teams = {}
    for g in games:
        for side in ("local", "road"):
            teams[g[side]["club"]["code"]] = g[side]["club"]["name"]
    todo = [g for g in games if g["gameCode"] not in prev]

    def one(g):
        b = get_json("https://live.euroleague.net/api/Boxscore", {"gamecode": g["gameCode"], "seasoncode": season})
        if not b or b.get("Live"):
            return None
        digits = "".join(ch for ch in str(b.get("Attendance") or "") if ch.isdigit())
        return [g["gameCode"], g["phaseType"]["code"], g["round"], (g.get("utcDate") or g["date"])[:10],
                g["local"]["club"]["code"], g["road"]["club"]["code"], g["local"]["score"], g["road"]["score"],
                int(digits) if digits and int(digits) > 0 else None] + parse_refs(b.get("Referees"))

    with ThreadPoolExecutor(4) as ex:
        new = [r for r in ex.map(one, todo) if r]
    rows = sorted(list(prev.values()) + new)
    year = int(season[1:])
    json.dump({"season": season, "label": f"{year}-{str(year + 1)[2:]}",
               "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "cols": ["code", "phase", "round", "date", "home", "away", "hs", "as", "att", "ref1", "ref2", "ref3"],
               "teams": teams, "games": rows}, open(path, "w"), separators=(",", ":"))
    print(season, "games:", len(rows), "new:", len(new), "failed:", len(todo) - len(new))


if __name__ == "__main__":
    for s in sys.argv[1:]:
        run(s)
