#!/usr/bin/env python3
"""herdr_hygiene — how many workspaces, tabs and agents are open, and how many are finished but left open.

Question
    What does the herdr surface look like right now: workspaces, tabs, agents by status,
    finished-but-open (`done`/`idle`) tabs and how long they have been finished, and `claude --bg`
    leftovers?

Definition key (evidence/DEFINITIONS.md)
    herdr_hygiene   Point in time (AS_OF, plus live at measurement): workspaces, tabs, agents by
                    status, finished-but-open (`done`/`idle`) tabs older than 24 h, `claude --bg`
                    leftovers. No history exists (herdr events are not recorded).

This is a LIVE measurement, not a replay of AS_OF: herdr keeps no history, so the AS_OF value cannot
be reconstructed. `measured_at` is the truth; `as_of` is only the nominal anchor. A Phase 0 janitor
wave (`rd reap`, event recorder) is running while the baseline is taken and may close tabs or kill
`claude --bg` leftovers, so these numbers can change between runs.

Inputs (all read-only)
    herdr workspace list · herdr tab list --workspace <id> (one call per workspace) · herdr agent list
    rd agents (lane tally, cross-check) · claude agents --json (background agents with start times)
    ~/.claude/projects/*/<session>.jsonl  last timestamped entry only (tail read), as the age proxy

Age: the herdr API carries no wall-clock timestamps (only sequence counters: `state_change_seq`,
`completion_seq`, `revision`). The time a finished agent has been idle is therefore approximated by
the timestamp of the last entry in its Claude transcript (not the file's mtime: something touches
transcripts without writing entries). Tabs whose agent has no resolvable transcript get
`age_hours: null` and are counted as unknown, never as young.

IuRoot: repo names, statuses and counts only; terminal titles (free text) are never written.

Run
    python3 -I herdr_hygiene.py          -> herdr_hygiene.out.json, herdr_hygiene.out.md
"""

import datetime as dt
import glob
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True  # evidence scripts write only their own outputs, never a __pycache__
sys.path.insert(0, str(HERE.parent / "lib"))
from redact import redact  # noqa: E402

UTC = dt.timezone.utc
AS_OF_STR = os.environ.get("AS_OF", "2026-10-22T08:00:00Z")
HOME = str(Path.home())
FINISHED = ("done", "idle")
STALE_HOURS = 24


def run(*cmd: str, timeout: int = 60) -> tuple[int, str]:
    try:
        r = subprocess.run(list(cmd), capture_output=True, text=True, errors="replace", timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 124, str(e)
    return r.returncode, r.stdout


def herdr_json(*args: str) -> dict:
    code, out = run("herdr", *args)
    if code != 0:
        raise RuntimeError(f"herdr {' '.join(args)} failed (rc={code})")
    d = json.loads(out)
    if "error" in d:
        raise RuntimeError(f"herdr {' '.join(args)}: {redact(str(d['error']))}")
    return d["result"]


STRUCTURED_LABEL_RX = re.compile(r"^(?:\d+|(?:wave|fan|mother|lead|orchestrator)\b[\w .-]*)$", re.I)


def safe_label(label: str, roots: set[str]) -> str:
    """IuRoot tab labels can carry work content: only structured labels (1, wave 3, fan x, mother...) are written for them."""
    if "IuRoot" in roots and not STRUCTURED_LABEL_RX.match(label.strip()):
        return "<label withheld>"
    return redact(label)


def tilde(p: str | None) -> str:
    return (p or "").replace(HOME, "~")


def repo_of(cwd: str | None) -> tuple[str, str]:
    """(root, repo) from a cwd: ~/SourceRoot/<repo>[/...] -> ("SourceRoot", repo); anything else -> ("other", "")."""
    c = tilde(cwd)
    m = re.match(r"^~/(SourceRoot|IuRoot)(?:/([^/]+))?", c)
    if not m:
        return "other", ""
    return m.group(1), m.group(2) or ""


def transcript_last_activity(session_id: str) -> tuple[float | None, str]:
    """Epoch of the last timestamped entry inside the session transcript, and how it was found.

    The file's mtime is not used as the primary signal: something touches transcripts without writing
    entries (an idle session's last entry can be a week old while its mtime is minutes old).
    """
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", session_id or ""):
        return None, "no session id"
    hits = glob.glob(os.path.join(HOME, ".claude", "projects", "*", f"{session_id}.jsonl"))
    if not hits:
        return None, "transcript not on this host"
    best = None
    for h in hits:
        size = os.stat(h).st_size
        window = 256 * 1024
        while True:
            start = max(0, size - window)
            with open(h, "rb") as fh:
                fh.seek(start)
                chunk = fh.read()
            lines = chunk.split(b"\n")
            if start > 0:
                lines = lines[1:]  # first line is cut
            found = None
            for raw in reversed(lines):
                if b'"timestamp"' not in raw:
                    continue
                try:
                    ts = json.loads(raw).get("timestamp")
                except json.JSONDecodeError:
                    continue
                if ts:
                    found = dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
                    break
            if found is not None or start == 0 or window >= 16 * 1024 * 1024:
                break
            window *= 4
        if found is not None and (best is None or found > best):
            best = found
    return (best, "last transcript entry") if best is not None else (None, "no timestamped entry found")


def iso(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def age_bucket(h: float | None) -> str:
    if h is None:
        return "unknown"
    for lim, name in ((1, "<1h"), (6, "1-6h"), (24, "6-24h"), (72, "1-3d")):
        if h < lim:
            return name
    return ">3d"


def parse_rd_agents(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        t = line.split()
        if len(t) < 4 or t[0] not in ("herdr", "bg", "interactive"):
            continue
        i = next((k for k, tok in enumerate(t) if tok.startswith(("~/", "/")) or tok == "~"), None)
        if i is None or i < 2:
            continue
        rows.append({"lane": t[0], "status": t[i - 1], "cwd": t[i], "ref": t[i + 1] if len(t) > i + 1 else ""})
    return rows


def main() -> int:
    measured = dt.datetime.now(UTC)
    now_ts = measured.timestamp()

    try:
        ws = herdr_json("workspace", "list")["workspaces"]
        tabs: list[dict] = []
        for w in ws:
            tabs += herdr_json("tab", "list", "--workspace", w["workspace_id"])["tabs"]
        agents = herdr_json("agent", "list")["agents"]
    except (RuntimeError, OSError, ValueError, KeyError) as e:
        # Not on the dev host (or herdr is down): write an honest empty result instead of failing the pipeline.
        out = {"script": "herdr_hygiene.py", "definition_keys": ["herdr_hygiene"], "as_of": AS_OF_STR,
               "measured_at": measured.strftime("%Y-%m-%dT%H:%M:%SZ"), "error": redact(str(e)),
               "reading": "herdr unreachable from this host; no measurement"}
        (HERE / "herdr_hygiene.out.json").write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        (HERE / "herdr_hygiene.out.md").write_text(f"# herdr_hygiene\n\nMeasured at `{out['measured_at']}`: herdr unreachable ({out['error']}). No numbers.\n", encoding="utf-8")
        print(f"herdr_hygiene: herdr unreachable: {out['error']}", file=sys.stderr)
        return 0
    code, rd_text = run("rd", "agents")
    rd_rows = parse_rd_agents(re.sub(r"\x1b\[[0-9;]*m", "", rd_text)) if code == 0 else []
    ccode, cj = run("claude", "agents", "--json")
    claude_agents = []
    if ccode == 0:
        try:
            claude_agents = json.loads(cj)
        except json.JSONDecodeError:
            claude_agents = []

    # Workspace groups: a separator workspace (label starts with "──") opens a group.
    sep = lambda w: w["label"].lstrip().startswith("──")
    group, ws_info = "(ungrouped)", {}
    for w in sorted(ws, key=lambda x: x["number"]):
        if sep(w):
            group = re.sub(r"[─\s]+", " ", w["label"]).strip() or "(unnamed)"
            ws_info[w["workspace_id"]] = {"label": w["label"], "separator": True, "group": group}
        else:
            ws_info[w["workspace_id"]] = {"label": w["label"], "separator": False, "group": group}
    repo_ws = [w for w in ws if not sep(w)]
    label_counts = Counter(w["label"] for w in repo_ws)
    by_group: dict[str, Counter] = defaultdict(Counter)
    for w in repo_ws:
        g = ws_info[w["workspace_id"]]["group"]
        by_group[g]["workspaces"] += 1
        by_group[g]["tabs"] += w["tab_count"]
        by_group[g][f"status_{w['agent_status']}"] += 1

    ag_by_tab: dict[str, list[dict]] = defaultdict(list)
    for a in agents:
        ag_by_tab[a["tab_id"]].append(a)
    max_seq = max((a.get("state_change_seq", 0) for a in agents), default=0)

    tab_rows = []
    for t in tabs:
        w = ws_info.get(t["workspace_id"], {})
        ags = ag_by_tab.get(t["tab_id"], [])
        ages, seqs, roots, repos = [], [], set(), set()
        for a in ags:
            root, repo = repo_of(a.get("cwd"))
            roots.add(root)
            if repo:
                repos.add(repo)
            seqs.append(a.get("state_change_seq", 0))
            mt, _how = transcript_last_activity((a.get("agent_session") or {}).get("value", ""))
            if mt is not None:
                ages.append((now_ts - mt) / 3600)
        # A tab is as old as its most recently active agent.
        age_h = round(min(ages), 1) if ages and len(ages) == len(ags) else None
        tab_rows.append({
            "workspace": redact(w.get("label", "")), "group": w.get("group"), "tab_id": t["tab_id"], "tab_label": safe_label(t["label"], roots),
            "status": t["agent_status"], "panes": t["pane_count"], "agents": len(ags),
            "root": sorted(roots)[0] if roots else None, "repo": sorted(repos)[0] if repos else None,
            "age_hours": age_h, "state_change_seq": max(seqs) if seqs else None,
            "events_since_state_change": (max_seq - max(seqs)) if seqs else None,
        })
    tab_status = Counter(r["status"] for r in tab_rows)
    finished = [r for r in tab_rows if r["status"] in FINISHED]
    finished.sort(key=lambda r: (-(r["age_hours"] if r["age_hours"] is not None else -1), r["tab_id"]))
    known = [r for r in finished if r["age_hours"] is not None]
    stale = [r for r in known if r["age_hours"] > STALE_HOURS]

    agent_status = Counter(a["agent_status"] for a in agents)
    wave_tabs = [r for r in tab_rows if re.match(r"^(wave|fan|mother|lead|orchestrator)\b", r["tab_label"], re.I)]

    # claude --bg leftovers
    bg = [a for a in claude_agents if a.get("kind") == "background"]
    bg_rows = []
    for a in bg:
        root, repo = repo_of(a.get("cwd"))
        started = a["startedAt"] / 1000 if a.get("startedAt") else None
        bg_rows.append({
            "id": (a.get("id") or a.get("sessionId", ""))[:8], "root": root, "repo": repo,
            "state": a.get("state") or a.get("status") or "?",
            "started_at": iso(started) if started else None,
            "age_hours": round((now_ts - started) / 3600, 1) if started else None,
            "last_activity_age_hours": (lambda m: round((now_ts - m[0]) / 3600, 1) if m[0] else None)(transcript_last_activity(a.get("sessionId", ""))),
        })
    bg_rows.sort(key=lambda r: r["id"])
    rd_lane = Counter(r["lane"] for r in rd_rows)
    rd_bg_status = Counter(r["status"] for r in rd_rows if r["lane"] == "bg")

    out = {
        "script": "herdr_hygiene.py",
        "definition_keys": ["herdr_hygiene"],
        "as_of": AS_OF_STR,
        "measured_at": measured.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "kind": "live measurement; herdr keeps no history, so AS_OF itself cannot be reconstructed",
        "phase0_warning": "A Phase 0 janitor wave (rd reap, herdr event recorder) is running while the baseline is taken and may close finished tabs "
                          "or kill claude --bg leftovers. Treat these numbers as the state at measured_at, not as a stable baseline; "
                          "compare against the next run, not against AS_OF.",
        "workspaces": {
            "total": len(ws), "separators": sum(1 for w in ws if sep(w)), "repo_workspaces": len(repo_ws),
            "by_agent_status": dict(sorted(Counter(w["agent_status"] for w in repo_ws).items())),
            "duplicate_labels": {redact(k): v for k, v in sorted(label_counts.items()) if v > 1},
            "by_group": {redact(g): dict(sorted(c.items())) for g, c in sorted(by_group.items())},
        },
        "tabs": {
            "total": len(tab_rows), "panes": sum(w["pane_count"] for w in ws),
            "by_agent_status": dict(sorted(tab_status.items())),
            "wave_fan_mother_orchestrator_labelled": len(wave_tabs),
            "per_workspace_max": max((w["tab_count"] for w in repo_ws), default=0),
        },
        "agents": {
            "total": len(agents), "by_status": dict(sorted(agent_status.items())),
            "by_kind": dict(sorted(Counter(a["agent"] for a in agents).items())),
            "named_by_rd": sum(1 for a in agents if a.get("name")),
            "hand_started": sum(1 for a in agents if not a.get("name")),
            "by_root": dict(sorted(Counter(repo_of(a.get("cwd"))[0] for a in agents).items())),
            "latest_state_change_seq": max_seq,
        },
        "finished_but_open_tabs": {
            "definition": "tabs whose agent_status is done or idle",
            "count": len(finished), "done": sum(1 for r in finished if r["status"] == "done"), "idle": sum(1 for r in finished if r["status"] == "idle"),
            "share_of_tabs": round(len(finished) / len(tab_rows), 4) if tab_rows else None,
            "share_of_agent_tabs": round(len(finished) / max(1, sum(1 for r in tab_rows if r["status"] != "unknown")), 4),
            "age_available": "no: the herdr API returns sequence counters, not timestamps; age_hours is the time since the last entry in the agent's Claude transcript",
            "older_than_24h": {"count": len(stale), "of_known_age": len(known), "unknown_age": len(finished) - len(known),
                               "count_if_all_unknown_were_stale": len(stale) + len(finished) - len(known)},
            "age_buckets": dict(sorted(Counter(age_bucket(r["age_hours"]) for r in finished).items())),
            "tabs": finished,
        },
        "claude_bg_leftovers": {
            "count": len(bg_rows), "by_state": dict(sorted(Counter(r["state"] for r in bg_rows).items())),
            "older_than_24h": sum(1 for r in bg_rows if r["age_hours"] is not None and r["age_hours"] > STALE_HOURS),
            "items": bg_rows,
            "source": "claude agents --json (kind = background)" if ccode == 0 else "claude agents --json unavailable",
        },
        "rd_agents": {
            "rows": len(rd_rows), "by_lane": dict(sorted(rd_lane.items())), "bg_statuses": dict(sorted(rd_bg_status.items())),
            "crosscheck": {"herdr_lane_rows": rd_lane.get("herdr", 0), "herdr_agent_list": len(agents),
                           "bg_rows": rd_lane.get("bg", 0), "claude_bg_agents": len(bg_rows),
                           "consistent": rd_lane.get("herdr", 0) == len(agents) and rd_lane.get("bg", 0) == len(bg_rows)},
            "note": "rd agents merges the herdr lane with `claude agents --json`; a Claude running in a herdr pane is listed once",
        },
        "notes": [redact(x) for x in [
            "Tabs with agent_status `unknown` hold a plain shell or an agent herdr does not detect; they are not counted as finished.",
            "Separator workspaces (labels starting with a rule) only group the sidebar and are excluded from repo_workspaces.",
            "age_hours is the time since the agent's last transcript entry; a later resume or a janitor message writes a new entry and makes the tab look younger.",
            "Terminal titles are free text and are not written to this file.",
        ]],
    }
    (HERE / "herdr_hygiene.out.json").write_text(json.dumps(out, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    write_md(out, HERE / "herdr_hygiene.out.md")
    f = out["finished_but_open_tabs"]
    print(f"herdr_hygiene @ {out['measured_at']}: {out['workspaces']['repo_workspaces']} workspaces, {out['tabs']['total']} tabs, "
          f"{out['agents']['total']} agents {out['agents']['by_status']}; finished-open {f['count']} (>24h known: {f['older_than_24h']['count']}/{f['older_than_24h']['of_known_age']}); "
          f"bg leftovers {out['claude_bg_leftovers']['count']}")
    return 0


def write_md(o: dict, path: Path) -> None:
    L = ["# herdr_hygiene", "", f"AS_OF `{o['as_of']}` (nominal). Measured live at `{o['measured_at']}`. Definition key `herdr_hygiene`. Script `herdr_hygiene.py`.", "",
         f"**{o['phase0_warning']}**", "", f"{o['kind'].capitalize()}.", "",
         "## Counts", "", "|what|count|", "|-|-|",
         f"|workspaces (repo workspaces)|{o['workspaces']['repo_workspaces']}|",
         f"|separator workspaces|{o['workspaces']['separators']}|",
         f"|tabs|{o['tabs']['total']}|", f"|panes|{o['tabs']['panes']}|", f"|agents|{o['agents']['total']}|",
         f"|finished-but-open tabs (done + idle)|{o['finished_but_open_tabs']['count']} ({o['finished_but_open_tabs']['done']} done, {o['finished_but_open_tabs']['idle']} idle)|",
         f"|of those older than 24 h (known age)|{o['finished_but_open_tabs']['older_than_24h']['count']} of {o['finished_but_open_tabs']['older_than_24h']['of_known_age']} with a known age|",
         f"|finished tabs with unknown age|{o['finished_but_open_tabs']['older_than_24h']['unknown_age']}|",
         f"|`claude --bg` leftovers|{o['claude_bg_leftovers']['count']} ({', '.join(f'{k}: {v}' for k, v in o['claude_bg_leftovers']['by_state'].items()) or 'none'})|",
         "", "Tabs by status: " + ", ".join(f"{k} {v}" for k, v in o["tabs"]["by_agent_status"].items()) + ".",
         "Agents by status: " + ", ".join(f"{k} {v}" for k, v in o["agents"]["by_status"].items()) + ".",
         "Workspaces by status: " + ", ".join(f"{k} {v}" for k, v in o["workspaces"]["by_agent_status"].items()) + ".", ""]
    dup = o["workspaces"]["duplicate_labels"]
    if dup:
        L += ["Workspace labels that appear more than once: " + ", ".join(f"{k} ({v})" for k, v in dup.items()) + ".", ""]
    L += ["## Workspaces by sidebar group", "", "|group|workspaces|tabs|", "|-|-|-|"]
    for g, c in o["workspaces"]["by_group"].items():
        L.append(f"|{g}|{c.get('workspaces', 0)}|{c.get('tabs', 0)}|")
    f = o["finished_but_open_tabs"]
    L += ["", "## Finished-but-open tabs", "", f"{f['age_available']}.", "",
          "Age buckets: " + ", ".join(f"{k} {v}" for k, v in f["age_buckets"].items()) + ".", "",
          "|workspace|tab|status|repo|age (h)|events since state change|", "|-|-|-|-|-|-|"]
    for r in f["tabs"]:
        L.append(f"|{r['workspace']}|{r['tab_label']}|{r['status']}|{r['repo'] or '-'}|{r['age_hours'] if r['age_hours'] is not None else 'unknown'}|{r['events_since_state_change'] if r['events_since_state_change'] is not None else '-'}|")
    b = o["claude_bg_leftovers"]
    L += ["", "## claude --bg leftovers", "", f"Source: {b['source']}. Older than 24 h: {b['older_than_24h']}.", "",
          "|id|repo|state|started|age (h)|last activity (h ago)|", "|-|-|-|-|-|-|"]
    for r in b["items"]:
        L.append(f"|{r['id']}|{r['repo'] or '-'}|{r['state']}|{r['started_at']}|{r['age_hours']}|{r['last_activity_age_hours']}|")
    rd = o["rd_agents"]
    L += ["", "## rd agents cross-check", "", f"Rows {rd['rows']} by lane {rd['by_lane']}; herdr lane rows {rd['crosscheck']['herdr_lane_rows']} vs `herdr agent list` {rd['crosscheck']['herdr_agent_list']}; "
          f"bg rows {rd['crosscheck']['bg_rows']} vs claude background agents {rd['crosscheck']['claude_bg_agents']}; consistent: {rd['crosscheck']['consistent']}.", "",
          "## Notes", ""] + [f"- {n}" for n in o["notes"]] + [""]
    path.write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
