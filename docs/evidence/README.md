# Evidence — conventions

The golden set and the intervention KPIs the factory still uses, moved here from dotfiles
(`docs/factory/evidence/`, archived as `docs/archive/factory-v2.4/` there). Every number comes from a
script here, with its output stored next to it. Nothing in the loop can edit these scripts' inputs: they
read frozen snapshots or append-only stores, read-only.

`ADR-NNN`, `BRIEF` and `report.html` in the scripts and outputs name the archived v2.4 set in dotfiles;
`docs/decisions.md` here supersedes it.

## Reproducibility

Run from the script's own directory with `python3 -I`; paths resolve from `__file__`, so the tree can sit anywhere
that keeps `lib/` and `signals/topology.out.json` as siblings of `golden/`.

- Re-run and diff clean: `golden/agreement.py`, `kpi/{baseline,decision_shadow,engine_policy,owner_pages,forecast}.py`,
  `interventions/interventions.py report`.
- Drift from stores that changed since 2026-10-22, so the stored `.out.*` are the frozen record, not re-run
  products: `golden/sample.py` (+ `chunk.py`, `packets.jsonl`, `chunks/`: fewer local clones to resolve fix links),
  `golden/backtest.py --verify` (differs, also in the old home), `kpi/cost.py` (the agent-gateway OpenCode store is
  gone), `kpi/{git_delivery,dora,quota,herdr_hygiene}.py` (live git, herdr, 3-day usage retention).
- The frozen snapshots stay in `~/.local/share/factory/snapshots/2026-10-22/`. `snapshot.sh` that made them stayed in
  the archive: the stores it copied (warden, agent-gateway, research-gateway) are gone, so it cannot run again.
- `signals/topology.out.json` is the one file kept from `signals/`; `golden/backtest.py` reads it. The script that
  produced it (`signals/signals.py`) and `postmortem/`, `incidents/`, `toil/`, `gameday/`, `projects/`, `questions/`
  stayed in the archive.

## Rules for every script

- **As-of time:** `AS_OF=2026-10-22T08:00:00Z` (env override). Filter every
  timestamped row to `< AS_OF`. Windows are named relative to it: `14d`, `30d`, `90d`, `all`.
- **Mutable stores come from the frozen snapshot**, never the live file:
  `~/.local/share/factory/snapshots/2026-10-22/{warden.db, agw-jobs.db, usage.db,
  research-jobs.sqlite, human-queue/}` — created by `snapshot.sh`. Open SQLite as
  `sqlite3.connect("file:<path>?mode=ro", uri=True)`.
- **Append-only stores are read live, filtered by `AS_OF`:** git (`git log --before`),
  Claude Code transcripts (`~/.claude/projects/**/*.jsonl`; MacBook copy via
  `ssh iumac`), OpenCode (`~/.local/share/opencode/opencode.db`, read-only), Hermes
  (`~/.hermes/state.db`, read-only), `~/Library/Logs/*`.
- **Never load a whole large store into memory or into an agent's context.** Stream
  files, aggregate in SQL, print summaries.
- **Language:** Python 3 stdlib only (`python3 -I`), or `sqlite3`/`jq`/`git` in shell.
  No network except `ssh iumac` / `ssh homelab` / `ssh vps` read commands.
- **Outputs:** `<script>.out.json` (machine-readable, every number the report cites,
  with its definition key) and, where useful, `<script>.out.md` (human table). Stable
  key order, so a re-run diffs cleanly.
- **Public repo:** dotfiles is public. Pass every free-text field (titles, payload
  excerpts, notes, commands, owner messages) through `lib/redact.py:redact()` before
  writing. No hostnames, IPs, tokens, internal URLs; `~` paths only; IuRoot repos by
  name only, never their content. Gate before commit:
  `python3 -I lib/redact.py --check $(git ls-files -mo --exclude-standard .)`.
- **Header:** each script starts with a docstring naming the question it answers, the
  definition keys from `DEFINITIONS.md` it implements, its inputs, and how to run it.
- Scripts run one by one; there is no `run-all.sh`. Scripts that read live systems over ssh, gh or herdr (signals, dora, toil, herdr hygiene, the MacBook transcript leg, gameday) reproduce only from this host.

## Layout

| Dir | Question |
|-|-|
| `kpi/` | the baseline, one definition per metric (`DEFINITIONS.md`) |
| `golden/` | ≥ 400 labelled warden events (entity-centric sample) and the backtest over them |
| `interventions/` | the twenty latest owner interventions, raw signal to closure |
| `lib/` | `redact.py`, the public-repo gate |
