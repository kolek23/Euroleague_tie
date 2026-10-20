"""Rebuild the attendance/referee snapshots in data/<season>.json.

Usage (from the repo root):  python scripts/scrape.py E2026 [E2025 ...]
Existing games are kept; only finished games missing from the file are fetched.
The website tops up the current season live in the browser, so this only needs to be
re-run occasionally to keep the snapshot fresh.

Sources: seasons 2007-08 onwards use the Boxscore API; 2000-01 .. 2006-07 are not in that API,
so they use the v1 /games endpoint (audience + referees). Some old seasons list four officials.
Requires: pip install requests
"""
import datetime, json, os, re, sys
from concurrent.futures import ThreadPoolExecutor
import requests

ROOT = os.environ.get("DATA_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
BAD = ("N/D", "N/A", "")


def get(url, params=None, as_json=True):
    for _ in range(4):
        try:
            r = requests.get(url, params=params, timeout=40)
            if r.status_code == 200:
                return r.json() if as_json else r.text
        except (requests.RequestException, ValueError):
            pass
    return None


def parse_refs(raw):
    """'A, B, C, D, E, F' (surname, first name pairs) -> up to 3 names."""
    parts = [p.strip() for p in (raw or "").split(",") if p.strip() not in BAD]
    refs = [", ".join(parts[i:i + 2]) for i in range(0, len(parts), 2)]
    return (refs + ["", "", ""])[:3]


def clean_refs(names, keep=4):
    """Normalise 'PUKL,SASA' -> 'PUKL, SASA', drop blanks and repeats, keep every official listed (max 4)."""
    out = []
    for n in names:
        n = re.sub(r"\s*,\s*", ", ", n.strip())
        if n and n not in BAD and n not in out:
            out.append(n)
    return (out + [""] * keep)[:max(keep, 3)] if len(out) <= 3 else out[:keep]


def modern(season, g):
    b = get("https://live.euroleague.net/api/Boxscore", {"gamecode": g["gameCode"], "seasoncode": season})
    if not b or b.get("Live"):
        return None
    digits = "".join(ch for ch in str(b.get("Attendance") or "") if ch.isdigit())
    return int(digits) if digits and int(digits) > 0 else None, parse_refs(b.get("Referees"))


def legacy(season, g):
    t = get("https://api-live.euroleague.net/v1/games", {"seasonCode": season, "gameCode": g["gameCode"]}, as_json=False)
    if not t or 'played="true"' not in t[:800]:
        return None
    a = re.search(r"<audience>(\d*)</audience>", t)
    names = re.findall(r'<referee name="([^"]*)"', t)
    return (int(a.group(1)) if a and a.group(1) and int(a.group(1)) > 0 else None), clean_refs(names)


def run(season):
    year = int(season[1:])
    path = os.path.join(ROOT, season + ".json")
    prev = {}
    if os.path.exists(path):
        prev = {r[0]: r for r in json.load(open(path))["games"]}
    feed = get(f"https://api-live.euroleague.net/v2/competitions/E/seasons/{season}/games")["data"]
    games = [g for g in feed if g["played"] and not g["local"]["club"]["isVirtual"] and not g["road"]["club"]["isVirtual"]]
    teams = {}
    for g in games:
        for side in ("local", "road"):
            teams[g[side]["club"]["code"]] = g[side]["club"]["name"]
    todo = [g for g in games if g["gameCode"] not in prev]
    fetch = legacy if year < 2007 else modern

    def one(g):
        res = fetch(season, g)
        if res is None:
            return None
        att, refs = res
        return [g["gameCode"], g["phaseType"]["code"], g["round"], (g.get("utcDate") or g["date"])[:10],
                g["local"]["club"]["code"], g["road"]["club"]["code"], g["local"]["score"], g["road"]["score"], att] + list(refs)

    with ThreadPoolExecutor(4) as ex:
        new = [r for r in ex.map(one, todo) if r]
    rows = sorted(list(prev.values()) + new)
    json.dump({"season": season, "label": f"{year}-{str(year + 1)[2:]}",
               "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "cols": ["code", "phase", "round", "date", "home", "away", "hs", "as", "att", "ref1", "ref2", "ref3", "ref4"],
               "teams": teams, "games": rows}, open(path, "w"), separators=(",", ":"))
    print(season, "games:", len(rows), "new:", len(new), "failed:", len(todo) - len(new))


if __name__ == "__main__":
    for s in sys.argv[1:]:
        run(s)
