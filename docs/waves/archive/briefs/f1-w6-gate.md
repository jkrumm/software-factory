Branch: f1-w6-gate
Title: docs(evidence): the F1 gate run, two chains, a wall and a drain with no owner continue
Owned files: `docs/evidence/f1-gate-run/**` (new), `scripts/gate-run/**` (new), and any fix the run forces in `packages/**` (each its own commit with a test; stop and report instead if a fix is larger than a small change). Never: `docs/decisions.md`, `docs/program.md`, `docs/design.md`, `docs/waves/**`.
Task:
F1 Wave 6's first step in `docs/waves/f1.md`: the track's gate. Read `AGENTS.md`, `docs/design.md` §3, `docs/decisions.md` FL1–FL8, and Waves 1–5's Left behind in `docs/waves/f1.md` first; `~/.claude/skills/wave/SKILL.md` is the chain contract the waves follow. The factory is live (`make verify`); `rd wave|fan|say|close` go through it when it answers.

**The claim to prove:** two chains of waves in two repos run to their end with an injected limit wall and one `drain` in the middle, and nobody types "continue" or anything else into any pane. Anything the run needs from a human is a failure to record, not a step.

1. **Two scratch repos** under `~/SourceRoot/` (inside `FACTORY_REPO_ROOTS`): `factory-gate-a` and `factory-gate-b`, each with a local bare remote (`~/.local/share/factory/gate-remotes/<name>.git`), no GitHub repo. Each holds a chain-mode `docs/waves/PLAN.md` of four waves of small real work (a tiny Bun module, one function and its test per wave, `make check` = `bun test`) so every wave commits, pushes and spawns its successor with `rd wave` itself. Script the setup in `scripts/gate-run/` so the run repeats.
2. **Start both chains** with `rd wave factory-gate-a|b 'Read docs/waves/PLAN.md. Execute the active wave (Wave 1). Follow the /wave skill.'` (the factory path). Record every spawn's account and role.
3. **Inject one limit wall** in chain A's Wave 2 while it works, through the real hook path (`factory hook stop-failure` with a `rate_limit` payload under that session's `FACTORY_SESSION`) and a reset that passes during the run: the account's next real 5-hour reset if it falls inside the run, otherwise a quota reading marked as a test row (say which in the evidence). The proof is the resume watchdog's one "continue" and the wave going on.
4. **One drain:** `factory queue set drain --project ~/SourceRoot/factory-gate-b` while chain B's Wave 2 works; its next spawn must print `queued: drain` and start nothing; after at least 10 minutes `factory queue set run`, and the queued spawn starts by itself.
5. **Observe without touching:** block on `factory session wait` / `factory status` / `herdr agent wait` in bounded foreground calls (at most ~9 minutes each, then look again), never `rd say` or type into a gate pane. Every 15 minutes append one line to the evidence log: time, each session's derived state, notes pending, queue state, accounts.
6. **Evidence** in `docs/evidence/f1-gate-run/README.md`: verdict first (pass or fail against the claim), the timeline, the wall and drain with their keys and timestamps, counts (waves, turns, prompts typed by the factory, owner inputs = 0), what broke and what was fixed. Raw logs next to it with nothing secret, no hostnames, no IPs.
7. **Cleanup:** both chains' tabs closed with `rd close`, the scratch repos and bare remotes removed after the evidence is written (keep the scripts).

Known before the run: a chain wave's `rd wave` spawn carries no parent since dotfiles `728df90` (with the caller as parent the send-back held the finishing wave's Stop until its successor ended); orchestrated waves and fan workers keep theirs. The run proves the chain side: every wave ends its turn after spawning its successor.

Budget: both chains on whatever accounts admission picks; Sonnet waves (the `wave` role). If an account wall is real rather than injected, record it: that is the same proof.
Validation: `make check` (foreground; check `uptime`, it flakes above load ~40) for any code change; the evidence README is the result.
Finish: commit per logical concern, push `f1-w6-gate`, open a ready PR, run `/review` on any code change and fix its blocking findings, wait for CI in the foreground with `timeout`. Report the PR URL, the verdict, the counts and anything the owner had to do (should be nothing). Do not merge.
Never touch files outside "Owned files". If the task needs one, stop and say which file and why.
