// The host block of the owner's registry (dotfiles config/claude-accounts.json): what the package did on his two machines before the
// block existed. The CLI tests and the parity fixtures run with it, so the golden outputs of health, refresh and expiry are the ones the
// dotfiles CLI printed. CLAUDE_ACCOUNTS_RELOGIN stays a seam of the ask command for the tests.
/* oxlint-disable no-template-curly-in-string -- the command is a shell parameter expansion, not a template */
import type { HostConfig } from '../src/index.ts'

const RELOGIN_ASK =
  'bash "${CLAUDE_ACCOUNTS_RELOGIN:-$HOME/SourceRoot/dotfiles/scripts/claude-relogin.sh}" {id} --ask --reason {reason}'

export const OWNER_HOST: HostConfig = {
  machines: [
    {
      match: 'mini',
      name: 'mini',
      peer: { name: 'macbook', ssh: ['iumac'], fixedVerbs: true, herdrCore: true },
    },
    {
      name: 'macbook',
      peer: { name: 'mini', ssh: ['mini'], herdrCore: true },
      wake: {
        push: 'bash "$HOME/SourceRoot/dotfiles/scripts/ask-human.sh" push {id}',
        notify:
          "osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title \"Claude sessions\" subtitle \"open Tinycast > Claude usage to fix\"' -e 'end run' {message}",
      },
    },
  ],
  reloginAsk: RELOGIN_ASK,
  reloginFix: 'claude-relogin {id} --machine {machine}',
  afterAdd: 'make -C "$HOME/SourceRoot/dotfiles" claude-accounts-setup',
}
