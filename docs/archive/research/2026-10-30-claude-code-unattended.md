# Claude Code for unattended sessions (research, 2026-10-30)

agw research run `01a18bad-b074-77a4-ad79-0358cd5c6a62` (standard).

## Bottom line

- **Background sessions are still a research preview.** Agent view (`claude agents`) and background dispatch (`claude --bg`, `/bg`, `/background`) are documented as research preview as of the 27–29 October 2026 docs; `claude attach <id|name>` remains the documented way to open one in a terminal. A per-user supervisor process hosts them, unpinned idle sessions are stopped after roughly an hour, and hooks do fire for them (notably `Notification`, `SessionStart`, `WorktreeCreate`).
- **Issue #97074 is still open with no fix and no Anthropic confirmation.** The ~1.8× five-hour-window gap for `claude -p` / `sdk-cli` has been independently reproduced several times through late October 2026, and the only "fixes" circulating are unofficial entrypoint relabeling.
- **For unattended agents you get six permission modes** (`default`/Manual, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`), documented hook payloads for `Stop`, `SessionStart`, `SessionEnd` and `Notification`, three `quota_auto_resume_*` notification matchers plus a `StopFailure` `rate_limit` matcher, and automatic continue after a claude.ai limit reset. **There is no official API for reading Max quota**; the closest official surfaces are `/usage` and the status line's `rate_limits` JSON.

## 1. Background sessions (`claude --bg`, agent view, `claude attach`)

**Status: research preview, not GA.** The agent-view page carries an explicit note: "Agent view is in research preview. The interface and keyboard shortcuts may change as the feature evolves." The parallel-agents comparison page likewise lists agent view as "Research preview". This is unchanged in docs dated 2026-10-27 through 2026-10-29. A third-party tracker puts the minimum version at v2.1.139 and status "Research Preview", for what that is worth.

**Surface.** `claude agents` opens the one-screen view; `claude --bg "…"` dispatches a background session and returns immediately, printing the session ID and management commands; `claude attach <id|name>` attaches in this terminal; companion commands are `claude logs`, `claude stop` (alias `claude kill`), `claude respawn [--all]`, `claude rm`, `claude agents --json [--all]`. `--bg` cannot be combined with `-p`/`--print`, and opening agent view requires an interactive terminal. `claude daemon status|logs|run|stop --any [--keep-workers]` manages the supervisor itself.

**Supervisor behaviour.** "A per-user supervisor process starts on demand, outlives your shell, and hosts every `claude agents`, `--bg`, and `/background` session." Each background session is its own Claude Code process; state persists on disk through auto-updates and supervisor restarts, and sessions survive machine sleep (their processes resume on wake and the supervisor reconnects rather than treating the gap as idle). Shutting the machine down still stops running sessions. `claude daemon stop --any` stops the supervisor and the sessions it hosts; `--keep-workers` leaves sessions running for the next supervisor to reconnect to. Because the supervisor is one process shared by every terminal, it inherits the environment of whichever shell cold-started it — hence the docs' advice to put proxy/CA/env settings in `~/.claude/settings.json` rather than a shell export.

**Idle timeout.** The official page only implies one: `Ctrl+T` pins a session and "keep[s] its process running while idle", and the process icon `∙` means "the process has exited… when you reply or attach, Claude restarts it from its saved conversation". The duration is not stated on the pages read. Two independent secondary sources put it at about one hour for an unpinned, unattached session, with actively working or input-waiting sessions not stopped this way — a feature request from June 2026 (v2.1.187) and a third-party feature digest both say the supervisor stops unpinned sessions "after the ~1h idle timeout". Treat the exact number as provisional.

**Hooks.** Hooks are not disabled for background sessions. `Notification` fires with `agent_needs_input` or `agent_completed` while agent view is open (those matchers exist precisely for background sessions), the agent-view page documents prompts being held while `SessionStart` hooks are still running as a session moves to the background, and `WorktreeCreate` explicitly fires "for a background session". Hook configuration from `~/.claude/settings.json` reaches them; cloud sessions are the exception that don't read local user settings.

## 2. Issue anthropics/claude-code#97074

**Open, no fix.** Issue #97074, "[BUG] Headless `claude -p` (entrypoint `sdk-cli`) uses ~1.8× more of the 5-hour window per token than interactive `cli`, same workload", was opened by `qvarker` on Sep 25, 2026, labelled `bug`, `area:cli`, `area:cost`, `api:anthropic`, `has repro`, `platform:linux`, and is still shown as **Open** with activity through Oct 29, 2026. No Anthropic reply, fix, or documented weighting appears in the thread; the last comments are further user reproductions and workaround discussion.

The original controlled A/B (Claude Code 2.1.282, Opus, high effort) measured ~1.6 $/1% of the five-hour window headless versus ~3.0 $/1% interactive, with non-overlapping ranges, after subtracting other account activity. Independent reproductions in the same thread:

- Pro plan, 2.1.283: 27%→56% headless vs 56%→73% interactive on the same 31 turns — about 2.0×.
- Team plan, 2.1.300: `sdk-cli` 84k weighted tokens per 1% and `sdk-ts` 80k, versus `claude-vscode` 238k — 2.83× and 2.97×.
- Windows, 2.1.312 (Oct 29): ~2.1× with a tool-heavy task.

The strongest mechanistic lead is the client label: the reporter found only `cc_entrypoint=sdk-cli` vs `cli` in the `x-anthropic-billing-header` block and the User-Agent differing on the wire, and a later comment reports that CLI 2.1.301 maps `sdk-ts`, `sdk-cli` and `sdk-py` to one client category `claude_code_sdk`, while `claude-vscode` is separate. One caveat noted in the thread: an interactive session launched from a shell that already exports `CLAUDE_CODE_ENTRYPOINT=sdk-cli` records `sdk-cli` too. Workarounds circulating are third-party commits that relabel the entrypoint (for example `CPROXY_ENTRYPOINT`, a t3code PR), which are undocumented and, as one commenter warns, could be read as circumventing usage limits under the Consumer Terms. Independent coverage on Oct 28 describes the evidence as user-run tests that do not establish whether the difference is intentional or a metering bug.

## 3. Features for unattended agents

**Permission modes.** Six modes: `default` (shown as Manual), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. `auto` puts a classifier model in place of you and is the built-in starting mode for interactive terminal and VS Code sessions from v2.1.283; `bypassPermissions` runs everything without asking and is documented as suitable for isolated containers and VMs only. For unattended runs the important change: `claude -p` and Agent SDK runs with no mode set start in Manual from v2.1.302, and calls needing approval are **denied** unless approved by an allow rule, hook, `canUseTool` callback, or `--permission-prompt-tool`. Recommended alternatives are `--permission-mode auto` or `--allowedTools`. Even in `bypassPermissions`, deny rules still apply and these are never auto-approved: explicit `ask` rules, tools requiring user interaction (`AskUserQuestion`, MCP `requiresUserInteraction`), recognized critical-path `rm`/`rmdir`, cross-session messaging safeguards, and out-of-working-directory reads when `permissions.blockReadsOutsideWorkingDirectories` is on. In `-p`, the few calls that would still prompt are denied. Project settings cannot set `auto` or `bypassPermissions` as `defaultMode`; bypass needs the flag, `--allow-dangerously-skip-permissions`, user/`--settings`/managed settings, and can be blocked with `permissions.disableBypassPermissionsMode`.

**Hook payloads (documented fields).** All hooks receive common input including `session_id`, `transcript_path`, `cwd` and `hook_event_name`; `transcript_path` is written asynchronously and may lag the current turn, so use `last_assistant_message` for final text.

- `SessionStart` — matcher on how the session started: `startup`, `resume`, `clear`, `compact`, `fork`; it fires again on resume (and on `--fork-session` as `fork`) so hooks can refresh context, and plain stdout is added to Claude's context.
- `SessionEnd` — matcher on why it ended: `clear`, `resume`, `logout`, `prompt_input_exit`, `other`. Its hooks share a 1.5-second budget (raised up to 60s only if a longer per-hook timeout is configured).
- `Stop` — fires when Claude finishes responding; input includes `stop_hook_active` and `last_assistant_message`; the hook can block the stop with a `decision`/`reason`, and `stop_hook_active` is the loop guard.
- `Notification` — input includes `message`, optional `title`, and `notification_type`; matchers cover `permission_prompt`, `idle_prompt`, `auth_success`, the `elicitation_*` set, `agent_needs_input`, `agent_completed`, `plugin_notification`, and the three `quota_auto_resume_*` values.

**Usage-limit events and resume.** Two distinct mechanisms:

1. `Notification` with `quota_auto_resume_fired` / `quota_auto_resume_stale` / `quota_auto_resume_disabled` (requires v2.1.234+) reports claude.ai subscription limits, not API 429s. `fired` means Claude Code continued the task at the reset — or sooner, when something you did during the wait (adding usage credits, upgrading the plan, switching models) made usage available, with a model-setting exception. `stale` means the reset happened while the machine slept more than ~30 minutes, so Claude Code waits for Enter. `disabled` means it stopped waiting without continuing: `autoContinueAtUsageLimit` turned off, the reset moved more than 24 hours away during a self-started wait, the continued task kept hitting the limit, or the continuation was blocked before reaching the model.
2. `StopFailure` with matcher `rate_limit` fires when a turn ends because of an API error; its matcher set also includes `overloaded`, `billing_error`, `authentication_failed`, `server_error` and others.

Session resume after a limit is a waiting-in-place behaviour: the session stays open and continues the interrupted task on its own after the reset, controlled by `autoContinueAtUsageLimit` (user or managed scope, v2.1.234+). Dynamic workflows extend this to their agents: agents that hit the limit wait and re-run after the reset instead of failing (v2.1.271+).

**Reading Max quota.** There is no official public API for Max subscription quota. Official surfaces are the `/usage` command (plan bars, attribution, usage-credits row, and a `Showing last-known usage` cache when the usage endpoint is rate-limited) and the status line JSON, which documents `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage` and their `resets_at` epoch seconds, plus gateway spend-limit fields. The usage numbers only exist for subscription sessions (absent for API-key auth). The stream-json output also carries `rate_limit_event.rate_limit_info.unifiedWindows.five_hour.utilization`, which is what several reporters used as their meter. The widely used `GET https://api.anthropic.com/api/oauth/usage` endpoint (OAuth bearer token from the local keychain) is undocumented and rate-limited per token; community tools rely on it, but it is not an official API.

## Citations
- [high] Agent view is in research preview (not GA) as of the 27-29 October 2026 docs — https://code.claude.com/docs/en/agent-view
- [high] Agent view is listed as Research preview on the parallel-agents comparison page — https://code.claude.com/docs/en/agents.md
- [high] claude attach <id|name>, claude agents, --bg, daemon subcommands exist with the described behaviour — https://code.claude.com/docs/en/cli-reference.md
- [high] A per-user supervisor starts on demand, outlives the shell, and hosts every claude agents/--bg//background session — https://code.claude.com/docs/en/network-config.md
- [high] Pinning a session keeps its process running while idle; an exited process restarts from its saved conversation on reply or attach — https://code.claude.com/docs/en/agent-view
- [medium] Unpinned background sessions are stopped by the supervisor after about one hour idle and unattached — https://github.com/anthropics/claude-code/issues/70491
- [medium] Idle cleanup stops a session process after ~1 hour idle and unattached; supervisor is a per-user daemon with daemon.log and roster.json — https://github.com/asivura/claude-almanac/blob/main/features/agent-view.md
- [high] Notification hook fires with agent_needs_input or agent_completed for background sessions while agent view is open — https://code.claude.com/docs/en/agent-view
- [high] WorktreeCreate fires for a worktree created for a background session — https://code.claude.com/docs/en/hooks
- [high] Issue #97074 is Open, opened Sep 25 2026, with bug/area:cli/area:cost/api:anthropic/has repro/platform:linux labels — https://github.com/anthropics/claude-code/issues/97074
- [high] Controlled A/B on 2.1.282 measured ~1.6 vs ~3.0 $ per 1% of the five-hour window (headless vs interactive) — https://github.com/anthropics/claude-code/issues/97074
- [high] Independent reproductions found ~2.0x (2.1.283), 2.83x/2.97x (2.1.300) and ~2.1x (2.1.312) drain rates — https://github.com/anthropics/claude-code/issues/97074
- [medium] Only cc_entrypoint (sdk-cli vs cli) and the User-Agent differed on the wire; sdk-ts/sdk-cli/sdk-py map to claude_code_sdk in 2.1.301 — https://github.com/anthropics/claude-code/issues/97074
- [high] Evidence is user-run tests, not an Anthropic finding, and does not establish intent or a metering bug — https://runtimewire.com/article/claude-code-sdk-subscription-usage-discrepancy
- [high] Six permission modes with the described auto-approval scopes — https://code.claude.com/docs/en/permission-modes.md
- [high] claude -p and Agent SDK runs with no mode set start in Manual from v2.1.302 and deny calls needing approval — https://code.claude.com/docs/en/permission-modes.md
- [high] Deny rules apply in every mode including bypassPermissions; ask rules, user-interaction tools, critical rm and out-of-directory reads are never auto-approved — https://code.claude.com/docs/en/permission-modes.md
- [high] SessionStart matchers: startup, resume, clear, compact, fork; SessionEnd matchers: clear, resume, logout, prompt_input_exit, other — https://code.claude.com/docs/en/hooks-guide.md
- [high] SessionEnd hooks share a 1.5-second budget, raised up to 60s if a longer timeout is configured — https://code.claude.com/docs/en/hooks
- [high] Notification input includes message, optional title and notification_type — https://code.claude.com/docs/en/hooks
- [high] Stop input includes stop_hook_active and last_assistant_message, used instead of the lagging transcript — https://code.claude.com/docs/en/hooks
- [high] quota_auto_resume_fired/stale/disabled matchers and their exact firing conditions (reset, earlier availability, >30 min sleep, 24h reset move, autoContinueAtUsageLimit off) — https://code.claude.com/docs/en/hooks-guide.md
- [high] The three quota_auto_resume matchers require Claude Code v2.1.234 or later — https://code.claude.com/docs/en/hooks-guide.md
- [high] StopFailure matcher values include rate_limit, overloaded, billing_error, server_error — https://code.claude.com/docs/en/hooks
- [high] Status line exposes rate_limits.five_hour/seven_day used_percentage and resets_at epoch seconds — https://code.claude.com/docs/en/statusline.md
- [high] /usage shows plan bars, usage credits and a last-known-usage cache when the usage endpoint is rate limited — https://code.claude.com/docs/en/costs.md
- [medium] A session that hits a claude.ai usage limit waits in the open session and continues after the reset; automatic continue is on by default for claude.ai subscription sessions — https://code.claude.com/docs/en/interactive-mode.md
