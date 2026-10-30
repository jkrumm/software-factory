# The twenty latest owner interventions, raw signal to closure

As of 2026-10-22T08:00:00Z. Mechanical part: `interventions.py` (candidates, `candidates.out.json`). Judgement: `judgments.json`. Rendered into `interventions.out.json` and this file by `interventions.py report`.

**How to read.** *When* is the moment the owner acted (a typed message, an approval click, an answer in Argo), UTC, newest first. An intervention is one owner action needed to unblock, correct or decide; several sources describing the same action are one entry, and distinct actions in one episode stay distinct (the `episode` field links them). *Genuinely the owner's* applies the fixed rule: only product direction, spend, irreversible data loss and other people are the owner's, nothing else. Owner quotes are translated or short; IuRoot sessions show repo and class only. A candidate is a heuristic tag set, never a verdict: I judged newest first and stopped at twenty distinct owner actions. New tasks, design talk, status pings, personal chat and agents relaying agents are not interventions.

**Pool.** Window 2026-10-01T08:00:00Z to 2026-10-22T08:00:00Z (21 d). 1119 candidates: human-queue 72, transcript-macbook 280, transcript-mini 678, warden-needs_decision 86, warden-operation 3. I read all 89 candidates since 2026-10-20T11:00:00Z (human-queue 10, transcript-macbook 25, transcript-mini 52, warden-needs_decision 1, warden-operation 1) and a second pass over what the prefilter dropped. The harness records text that an orchestrator types into a worker pane (`rd say`) as owner-typed: 3181 of 5224 entries with the human marker in the window were agent-authored and are dropped before any candidate exists.

Reading the dates: after 2026-10-16 the owner stopped closing warden items by hand (the last transition out of `needs_decision` by hand, CLI or adopt is 10-16 23:22Z), so the latest twenty come almost entirely from transcripts and the human-queue. That is a finding, not a gap in the data.

**Headline.** 4 of 20 were genuinely the owner's (20 %): each of them is in the business-decision class and no other class was genuine. The 20 interventions are 12 episodes spanning 2026-10-20 15:48:28Z to 2026-10-22 07:24:03Z (40 h); the largest are HomeLab HDD outage (10-21 to 10-22) (4), Mini disk crisis (10-20) (4).

## The interventions, newest first

### 1. 2026-10-22 07:24:03Z, homelab (human-queue)

- **Episode:** HomeLab HDD outage (10-21 to 10-22)
- **Signal:** The disk was mounted again at 07:15Z. WeatherOrb's archive work needed root on the homelab to prove that an immutable flag blocks an S3 PUT on a probe file and then to install a systemd timer that seals settled archive files.
- **Agent/system did:** Prepared a reviewed rollout script and queued it through the present-human gate; the agent has no root on that host.
- **Owner had to:** Approved the dialog at the MacBook; the command ran 3 s after it was queued.
- **Closure:** 07:24:03Z: probe PUTs denied as designed, 5,709 files sealed, timer active with the next run in ten minutes.
- **Class:** missing capability/permission. **Genuinely the owner's:** n.
- **Ideal path** (host verb, verification evidence): A named, reviewed root verb for the seal rollout on the homelab (an allow-listed script of the same shape as the mount guard) that the agent runs over the tailnet. The probe output it printed is already the verification evidence; the dialog added none.

### 2. 2026-10-22 07:17:32Z, weatherorb (transcript-mini)

- **Episode:** HomeLab HDD outage (10-21 to 10-22)
- **Signal:** At 16:09Z on 10-21 the homelab agent told the WeatherOrb orchestrator to hold its S3 archive probes: the external disk had not come back, so the gateway served an empty stand-in directory. The orchestrator parked the work and waited to be told.
- **Agent/system did:** Waited 15 h for a message instead of polling the one fact it needed: is the mount present and the bucket writable.
- **Owner had to:** Typed that the HomeLab HDD and S3 were back into the waiting session.
- **Closure:** 07:17:57Z: the agent ran its own mount check and the held bucket checks within 25 s of the message and resumed.
- **Class:** agent stopped or asked needlessly. **Genuinely the owner's:** n.
- **Ideal path** (durable retry, verification evidence): An await-condition on the hold: a probe (mountpoint plus a write-denied canary) re-evaluated on a timer that resumes the parked wave when it turns green. The owner is not a message bus for a state the agent can read.

### 3. 2026-10-22 07:15:11Z, homelab (human-queue, transcript-mini)

- **Episode:** HomeLab HDD outage (10-21 to 10-22)
- **Signal:** Unplanned homelab reboot at 15:53Z on 10-21 (power or hang). The host was back at 16:04Z, but the external encrypted disk stayed off the USB bus, so every container binding it was stopped. The agent's last word that evening: nothing moves until the enclosure is power-cycled at the site; tell me when.
- **Agent/system did:** Contained the outage within 20 min (dependents stopped, mountpoint locked), wrote the restore checklist to memory and waited.
- **Owner had to:** Told the agent at 07:15 that a person on site had switched the disk back on, then approved the mount-guard dialog (unlock and mount) at the MacBook; it appeared and was approved within 2 s.
- **Closure:** 07:15:24Z: the 14 TB volume (22 % used) and the transfer volume mounted and writable. The outage lasted 15 h 22 min; the host-side fix took 13 s from the owner's message.
- **Class:** infra needing a present human (biometric/TCC/GUI). **Genuinely the owner's:** n.
- **Ideal path** (host verb, durable retry): The replug is a person on site, not a decision: a standing, owner-pre-approved message to that person with the exact instruction goes out at detection. The rest needs no human: a device unit that unlocks and mounts on appearance, or an allow-listed mount verb the agent runs the moment its poll sees the disk.

### 4. 2026-10-21 22:13:29Z, basalt-ui (transcript-mini)

- **Signal:** The basalt orchestrator reported argo Wave 53 done and started Wave 54 while listing the remaining rollout waves, all for an app that is due a major overhaul.
- **Agent/system did:** Kept executing the argo wave list.
- **Owner had to:** Decided to stop investing in argo ('chill with the Argo effort, it will get a major overhaul anyways') and said WeatherOrb is coordinated from its own session.
- **Closure:** 22:14:06Z: the orchestrator told the argo Wave 54 tab to stop at the next clean point and rewrote the remaining wave list; the generic basalt fixes stay.
- **Class:** business decision. **Genuinely the owner's:** y.
- **Ideal path** (genuinely owner, policy line): Genuinely the owner's: product direction and spend. The system's share is to hold the decision as project state (lifecycle: paused, with the reason) that every orchestrator reads, instead of one relayed message to one tab.

### 5. 2026-10-21 19:48:03Z, prometheus-scripts (transcript-mini)

- **IuRoot session:** repo name and class only; the content is withheld by rule.
- **Class:** business decision. **Genuinely the owner's:** y.
- **Ideal path** (mechanism only): genuinely owner.

### 6. 2026-10-21 16:31:32Z, homelab (transcript-mini)

- **Signal:** A critical PHP remote-code-execution advisory, with fixed releases the same day, reached the owner through the news, not through the system.
- **Agent/system did:** Nothing: no check matches new advisories against the container inventory, and the agent was mid-outage.
- **Owner had to:** Typed one line suggesting that any container running PHP be upgraded.
- **Closure:** 16:32:49Z: the agent inspected all 36 homelab containers and every VPS container for PHP in about 70 s, with a control image proving the check works. Nothing runs PHP, nothing to upgrade.
- **Class:** other. **Genuinely the owner's:** n.
- **Ideal path** (known-error recipe, verification evidence): An advisory recipe run automatically: match new critical advisories against the container and package inventory per host and speak only on a positive. The agent's 70-second answer shows it is cheap enough to run on every advisory.

### 7. 2026-10-21 16:29:14Z, homelab (human-queue, transcript-mini)

- **Episode:** HomeLab HDD outage (10-21 to 10-22)
- **Signal:** The same outage in its first hour. An external uptime monitor emailed the owner about connection issues before anything in the system told him. Over the whole outage warden opened 54 items (19 attached as duplicates, 14 escalated to needs_decision, 11 of those asking for a read-only host shell).
- **Agent/system did:** The homelab agent diagnosed the reboot and the missing disk in under 5 min, found that the watchdog logged the missing mount yet reported healthy (fixed and deployed by 16:10:48Z), stopped every container that binds the volume and wrote a mountpoint guard. Locking the bare mountpoint (clear SSD stand-in directories, set the immutable flag) needed root.
- **Owner had to:** Approved the root dialog within 2 s, then asked the agent what was going on because he had only the monitor's emails.
- **Closure:** 16:29:14Z: 325 MB of stand-ins cleared and the mountpoint immutable; 16:30:35Z: the owner had the explanation (down 15:53Z, back 16:04Z, disk physically missing).
- **Class:** missing capability/permission. **Genuinely the owner's:** n.
- **Ideal path** (host verb, known-error recipe, policy line): One incident, not 54 items: fold co-firing alerts by host and time window, auto-close on recovery, and give investigate a read-only host verb (11 of the 14 pages were that gap). A boot-time root unit that locks the mountpoint before Docker starts means the approval never exists, and the owner learns from one message instead of from an external monitor.

### 8. 2026-10-21 15:56:21Z, basalt-ui (transcript-macbook, transcript-mini)

- **Episode:** Max quota pause and resume (10-20 to 10-21)
- **Signal:** The Max 7-day window was nearly spent (97 % the next morning). The basalt orchestrator had been parked at the owner's direction since 10-19, knowing the reset time; the WeatherOrb and shutterflow orchestrators since the owner's spend freeze (entry 17). The shutterflow one had also died on an API error at 22:22Z and idled for 17.6 h.
- **Agent/system did:** Held position as directed ('still paused'); a parked session resumes only when someone types. A stop hook made the basalt session repeat 'still paused' eleven times in 34 s on 10-19.
- **Owner had to:** Typed a short continue note, with the reset five minutes away, into each of the three sessions at 15:56Z and 'go now' into two of them at 15:58Z, after a pause of about 23 h (at least 45 h for the basalt session).
- **Closure:** 15:56:52Z: the orchestrator read the usage file and waited out the reset; the planned basalt Wave 42 and argo Wave 46 started at about 16:00Z and the shutterflow fleet resumed its gates.
- **Class:** agent stopped or asked needlessly. **Genuinely the owner's:** n.
- **Ideal path** (durable retry, policy line): A timer keyed to the quota window: a pause is parked work with a resume-at (the usage fetcher already knows the reset), so waves restart themselves at the reset. Quota headroom is a control input, not a chat message.

### 9. 2026-10-21 10:01:46Z, dotfiles (warden-needs_decision, warden-operation)

- **Signal:** A brief the owner filed (supervise the Obsidian launch agent) became warden item 1706. The implementer paused with a [product] question: add KeepAlive and accept a respawn after a human quits, or keep it unsupervised with a five-minute watchdog that reopens it only when down.
- **Agent/system did:** Escalated a design choice that the repo's own AGENTS.md already decides: Obsidian is deliberately started without KeepAlive, or it respawns the instant a human quits it.
- **Owner had to:** Answered through Argo at 10:01:46Z, 30 min after the question (an owner:argo authorisation).
- **Closure:** Not closed: at 10:06:56Z the item asked the same question again in different words, and it was still in needs_decision at the snapshot.
- **Class:** agent stopped or asked needlessly. **Genuinely the owner's:** n.
- **Ideal path** (policy line): A policy line: documented invariants (AGENTS.md, ADRs) bind and are read before escalating, and only a business question may page. A repeated question after an answer is a loop-breaker signal, not a second page.

### 10. 2026-10-21 09:14:41Z, tinycast-extensions (transcript-macbook)

- **Signal:** The Claude usage menu-bar app on the MacBook showed 'unauthorized' with no weekly figure.
- **Agent/system did:** Nothing proactive: the expired OAuth token made the usage fetcher write an error file, and no check paged on it.
- **Owner had to:** Noticed the menu bar himself, asked why, and ran /login (a browser OAuth step).
- **Closure:** 09:15:33Z: the usage file refreshed with valid data (weekly 97 %); diagnosis was an expired token behind a 401.
- **Class:** infra needing a present human (biometric/TCC/GUI). **Genuinely the owner's:** n.
- **Ideal path** (known-error recipe, verification evidence): A known-error recipe for credential expiry: probe the token age or the fetch result on a timer and push one notification with the exact re-login step before the display breaks. The login is a browser step only a person can do; noticing that it is due is not.

### 11. 2026-10-20 17:07:22Z, shutterflow (transcript-macbook)

- **Signal:** A Finder window on the lab log folder kept popping up on the MacBook.
- **Agent/system did:** Every `make check` ran an API test that sent the 'reveal logs' request to a server built with the real macOS launcher, which opened Finder on the newest log.
- **Owner had to:** Mentioned it in passing ('super annoying'), then answered which window it was when asked.
- **Closure:** 18:00:47Z (53 min later): fix 155a8c9a injects a fake launcher in that test.
- **Class:** wrong output corrected. **Genuinely the owner's:** n.
- **Ideal path** (verification evidence, known-error recipe): Side-effect verification: tests run with GUI and launcher capabilities faked by default, and a check fails any test that spawns a real `open`. The owner would never see it.

### 12. 2026-10-20 16:57:48Z, dotfiles (transcript-macbook)

- **Signal:** A mini agent reported that its deliverables could not be copied to the MacBook because the MacBook was unreachable, and stopped there.
- **Agent/system did:** Stopped with a note. The MacBook had been asleep with the lid closed, so the copy over the reverse SSH door timed out.
- **Owner had to:** Pasted the agent's report into a fresh MacBook session and asked what was going on, to fix the connection and move the files.
- **Closure:** 17:01:25Z (3.6 min later): files in place on the MacBook and the mini's reach verified.
- **Class:** agent stopped or asked needlessly. **Genuinely the owner's:** n.
- **Ideal path** (durable retry): Durable retry on a delivery that targets a laptop that sleeps: queue the copy and retry on wake, or deliver through an always-on inbox (the HomeLab bucket) and say where it is. A client machine being unreachable is not a stopping condition.

### 13. 2026-10-20 16:41:59Z, dotfiles (human-queue)

- **Episode:** Mini disk crisis (10-20)
- **Signal:** The audit found 246 GiB in the mini's Trash, which Finder never empties on a headless machine.
- **Agent/system did:** Measured it (media, VM data, game and app bundles) and asked for approval, flagged as irreversible.
- **Owner had to:** Approved emptying within 1 s in the native dialog.
- **Closure:** 16:41:59Z: free space 155 to 401 GiB (83 % to 56 % used).
- **Class:** business decision. **Genuinely the owner's:** y.
- **Ideal path** (genuinely owner, policy line): Irreversible data loss is the owner's by the rule, but the call was already his: he trashed those items. A standing delegation (Trash older than 30 days is emptied by the daily sweep, an allowlist for holds) turns this into a setting.

### 14. 2026-10-20 16:38:20Z, dotfiles (human-queue)

- **Episode:** Mini disk crisis (10-20)
- **Signal:** WeatherOrb moves its archive to a HomeLab S3 bucket; the push key (put and read, no delete) had to reach the mini's secrets cache.
- **Agent/system did:** Added the refs to the private refs file and queued a cache reseal.
- **Owner had to:** Approved the reseal: one biometric pass at the MacBook.
- **Closure:** 16:38:20Z: done 2 s after the request.
- **Class:** infra needing a present human (biometric/TCC/GUI). **Genuinely the owner's:** n.
- **Ideal path** (durable retry): Batch and defer: a reseal is idempotent, so queue ref changes and let one biometric pass at a time of the owner's choosing fold them in while the agent continues on a fixture. 18 of the 72 asks in 21 days were reseals.

### 15. 2026-10-20 16:36:47Z, dotfiles (human-queue)

- **Episode:** Mini disk crisis (10-20)
- **Signal:** The disk audit could not read the mini's protected folders (Trash, Mail, Messages, device backups): about 200 GiB unaccounted for.
- **Agent/system did:** Asked for a read-only `du` over ssh from the MacBook. The first ask sat unanswered for 31 min and was superseded by a second.
- **Owner had to:** Approved the second ask at the MacBook.
- **Closure:** 16:36:47Z: the output showed the 246 GiB Trash and the rest of the budget.
- **Class:** infra needing a present human (biometric/TCC/GUI). **Genuinely the owner's:** n.
- **Ideal path** (host verb, policy line): Grant a disk-measure helper Full Disk Access once, under its own binary path, and read its report. AGENTS.md now records that agents cannot see the Trash; measure continuously so the first sign is a trend line, not a 66 GiB floor.

### 16. 2026-10-20 16:31:07Z, homelab (human-queue, transcript-mini)

- **Episode:** HomeLab file doors (10-19 to 10-20)
- **Signal:** After a homelab reboot Docker could start before Tailscale, so containers bound to the tailnet address failed. The fix is a systemd drop-in, which needs root.
- **Agent/system did:** Queued the drop-in install (sudo through 1Password) at 16:04Z; the dialog went unanswered for 26 min.
- **Owner had to:** Typed that he was at the MacBook to approve at 16:31:07Z. The first run failed (exit 1, no output); the retry 82 s later succeeded.
- **Closure:** 16:32:40Z: drop-in installed; Docker is now ordered after the Tailscale unit.
- **Class:** missing capability/permission. **Genuinely the owner's:** n.
- **Ideal path** (host verb, durable retry): A reviewed root verb for installing a drop-in and a retry that surfaces the failure text; the 26-minute wait is the price of a gate only the MacBook can open.

### 17. 2026-10-20 16:24:16Z, shutterflow (transcript-macbook, transcript-mini)

- **Episode:** Max quota pause and resume (10-20 to 10-21)
- **Signal:** The Max 7-day window was close to its cap with a day left, while the shutterflow fleet and the WeatherOrb orchestrator were still spawning reviewers and waves.
- **Agent/system did:** Kept orchestrating at full rate until told; then cut to finish-only, parked what needed another big round, and paused its watchers.
- **Owner had to:** Decided to spend only what is necessary until the limit resets the next day (shutterflow 16:24Z, WeatherOrb 16:25Z); an hour earlier he had told the shutterflow lead to be a bit careful.
- **Closure:** 16:24:28Z: the fleet lead confirmed finish two near-done tasks, one release, then idle. Resumed by hand the next day (entry 8).
- **Class:** business decision. **Genuinely the owner's:** y.
- **Ideal path** (genuinely owner, policy line): Spend is the owner's call, made once as a standing headroom policy (above 90 % of the 7-day window: finish in-flight work, park the rest, resume at the reset). With that line neither this message nor entry 8 exists.

### 18. 2026-10-20 16:23:44Z, prometheus-scripts (transcript-mini)

- **IuRoot session:** repo name and class only; the content is withheld by rule.
- **Class:** wrong output corrected. **Genuinely the owner's:** n.
- **Ideal path** (mechanism only): verification evidence.

### 19. 2026-10-20 16:16:07Z, homelab (human-queue)

- **Episode:** HomeLab file doors (10-19 to 10-20)
- **Signal:** Verifying the new `hl` file wrapper: a Finder mount of the HomeLab bucket from the MacBook with the admin key.
- **Agent/system did:** Queued the test through the present-human gate. Run headless, the mount died on macOS ('Operation not permitted'), because the Network Volumes grant needs a GUI session.
- **Owner had to:** Approved; the run failed within the second. The mount was then verified from a Terminal session with the grant.
- **Closure:** 16:37:35Z (21 min): commit aaae4bd 'mount verified on the MacBook; note the Network Volumes grant'.
- **Class:** infra needing a present human (biometric/TCC/GUI). **Genuinely the owner's:** n.
- **Ideal path** (known-error recipe): A known-error recipe: Finder and NFS mounts need a GUI-session TCC grant, so a headless ask can never pass; route it to a one-time interactive grant and never queue it again (now in AGENTS.md).

### 20. 2026-10-20 15:48:28Z, weatherorb (transcript-mini)

- **Episode:** Mini disk crisis (10-20)
- **Signal:** The mini's 926 GiB Data volume was at 66 GiB free, 16 GiB above the 50 GiB floor, with a 22 GB WeatherOrb round build about to start. Nobody owned a machine-wide disk budget; WeatherOrb's own plan freed 23 GB.
- **Agent/system did:** Planned a local fix inside WeatherOrb (retire the test blends, about 23 GB).
- **Owner had to:** Said, with some force, that he wanted to know what was taking the disk, and told the orchestrator to spawn an agent that brings the data problem under control once and for all: audit the whole machine and move history to the HomeLab.
- **Closure:** 17:06:38Z (78 min): 66 to 431 GiB free (Trash 246, Colima trim 37, an orphaned VM disk 28, caches); a daily disk-sweep job installed (bf655d7), close-out in 160ce11.
- **Class:** other. **Genuinely the owner's:** n.
- **Ideal path** (policy line, known-error recipe): A disk-budget reconciler with an owner per path and a trend alert well above the floor, plus the daily sweep that now exists, installed before the crisis. The audit freed 365 GiB almost entirely by routine sweeps; the Trash was its only business decision.

## Summary

| Class | n |
|-|-|
| business decision | 4 |
| missing capability/permission | 3 |
| agent stopped or asked needlessly | 4 |
| wrong output corrected | 2 |
| infra needing a present human (biometric/TCC/GUI) | 5 |
| other | 2 |
| **total** | **20** |

| Genuinely the owner's (y) | Removable (n) | Share y |
|-|-|-|
| 4 | 16 | 20 % |

This share is among interventions, not items: the 0.1 % target is per warden item and has a different denominator.

| Repo (an entry spanning several repos counts once in each) | n |
|-|-|
| dotfiles | 6 |
| homelab | 6 |
| weatherorb | 5 |
| shutterflow | 3 |
| basalt-ui | 2 |
| prometheus-scripts | 2 |
| argo | 1 |
| tinycast-extensions | 1 |

| Mechanism that removes the need (an entry can cite several) | entries |
|-|-|
| policy line | 8 |
| verification evidence | 6 |
| host verb | 5 |
| durable retry | 6 |
| known-error recipe | 6 |
| different engine/spawner | 0 |
| genuinely owner | 4 |

| Episode with more than one entry | entries |
|-|-|
| HomeLab HDD outage (10-21 to 10-22) | 4 |
| Mini disk crisis (10-20) | 4 |
| HomeLab file doors (10-19 to 10-20) | 2 |
| Max quota pause and resume (10-20 to 10-21) | 2 |

| # | When (UTC) | Repo | Class | Owner's |
|-|-|-|-|-|
| 1 | 2026-10-22 07:24:03Z | homelab | missing capability/permission | n |
| 2 | 2026-10-22 07:17:32Z | weatherorb | agent stopped or asked needlessly | n |
| 3 | 2026-10-22 07:15:11Z | homelab | infra needing a present human (biometric/TCC/GUI) | n |
| 4 | 2026-10-21 22:13:29Z | basalt-ui | business decision | y |
| 5 | 2026-10-21 19:48:03Z | prometheus-scripts | business decision | y |
| 6 | 2026-10-21 16:31:32Z | homelab | other | n |
| 7 | 2026-10-21 16:29:14Z | homelab | missing capability/permission | n |
| 8 | 2026-10-21 15:56:21Z | basalt-ui | agent stopped or asked needlessly | n |
| 9 | 2026-10-21 10:01:46Z | dotfiles | agent stopped or asked needlessly | n |
| 10 | 2026-10-21 09:14:41Z | tinycast-extensions | infra needing a present human (biometric/TCC/GUI) | n |
| 11 | 2026-10-20 17:07:22Z | shutterflow | wrong output corrected | n |
| 12 | 2026-10-20 16:57:48Z | dotfiles | agent stopped or asked needlessly | n |
| 13 | 2026-10-20 16:41:59Z | dotfiles | business decision | y |
| 14 | 2026-10-20 16:38:20Z | dotfiles | infra needing a present human (biometric/TCC/GUI) | n |
| 15 | 2026-10-20 16:36:47Z | dotfiles | infra needing a present human (biometric/TCC/GUI) | n |
| 16 | 2026-10-20 16:31:07Z | homelab | missing capability/permission | n |
| 17 | 2026-10-20 16:24:16Z | shutterflow | business decision | y |
| 18 | 2026-10-20 16:23:44Z | prometheus-scripts | wrong output corrected | n |
| 19 | 2026-10-20 16:16:07Z | homelab | infra needing a present human (biometric/TCC/GUI) | n |
| 20 | 2026-10-20 15:48:28Z | weatherorb | other | n |

What removes most of them. Four mechanisms remove 15 of the 16 removable entries: a durable resume (API-error stalls, quota resets, waiting on a dependency the agent can poll), host verbs (a named root script and a read-only host read instead of a dialog), a known-error recipe (credential expiry, TCC grants, advisory-to-inventory) and a policy line (documented invariants bind, a standing quota-headroom rule, a Trash delegation); the sixteenth needs verification evidence only. Four of the twenty are the owner's by the rule: two of them (the Trash, quota headroom) become a one-time setting once stated, a third (pausing argo) becomes project state every orchestrator reads, and only the work-repo merge and release stays a call per case.

Evidence for the durable resume, from the same candidates: 26 owner messages in 21 days are typed straight after an agent turn that ended on a transient API error. 21 of them start with 'continue', 20 are in one MacBook orchestrator session, and all 26 are MacBook sessions (network loss on a laptop), none on the always-on mini. Each follows a median of 1.2 h and a maximum of 23.4 h of idle agent time, 131 h in total.

## Not counted, and why

- Next oldest, outside the twenty (2026-10-20, MacBook and mini): a shutterflow orchestrator revived with 'you can continue' after 23.4 h stalled on an API error (15:01Z); the Tinycast watchdog install where the owner ran the GUI checks by hand, a banner and a Pause/Resume toggle the agent could not observe (15:14Z); an agent-gateway implementer that ended on its own recommendation and waited for 'do so' (14:49Z); the Tinycast router session where the agent advised a manual network switch that would cut its own session, ran a join-and-return script that stranded the Mac, and claimed the Mac had recovered on its own (14:23Z, four corrections, then a battery pull on the router); and a correction that a Copernicus account already existed in the secrets store (13:31Z).
- Warden: 43 items sat in `needs_decision` at the snapshot, 38 of them first seen since 10-16, the oldest from 2026-09-12. They are escalations without a closure, so they are not interventions yet. In the 21-day window warden recorded 86 owner touches out of `needs_decision` (45 closed by hand, 24 CLI re-investigations, 16 adopted by owner, 1 answered in Argo), 18 of them citing the improve-loop session, an agent in the owner's seat. The last by hand, CLI or adopt is 10-16 23:22Z; the one later touch is the Argo answer (entry 9).
- Around the HDD outage warden opened 54 items between 15:50Z on 10-21 and 08:00Z on 10-22: 19 attached as duplicates, 14 escalated to `needs_decision`, 11 of those 14 asking to be granted a read-only host shell or to have host checks re-run. The owner touched none of them; the host-read gap is the Phase 0 investigate fix.
- Human-queue asks answer in 1 to 3 s when the owner sits at the MacBook (the push dialog), and wait up to 31 min when he does not. Of 72 asks in the window, 48 ran, 19 failed, 4 never got a reply and 1 was superseded; 14 asks were retries of an earlier one (a recurring cause: `op` reading the piped stdin as a JSON template), 42 are tagged as a biometric `op` call and 18 as secrets-cache reseals.
- Dropped before judging: first prompts and wave briefs (`rd wave`), agent-to-agent text typed through `rd say` or `herdr agent prompt` (recorded by the harness as owner-typed), sessions of agent-only worktrees, and the owner's personal-vault chat (excerpts withheld in `candidates.out.json`).
