/** Where a person's hands must be for a request: the MacBook, the iPhone, a web portal, or anywhere. */
export const HOSTS = ['macbook', 'iphone', 'portal', 'any'] as const
export type Host = (typeof HOSTS)[number]

/** The words that name where a person's hands must be; the first match wins, and nothing is `any`. */
const WHERE: readonly { host: Host; names: RegExp }[] = [
  { host: 'iphone', names: /\b(?:iphone|ipad|ios|testflight|ntfy topic|on the phone)\b/i },
  {
    host: 'macbook',
    names: /\b(?:macbook|touch id|biometric|secrets-seed|sudo|sudoers|keychain|hc run|full disk access)\b/i,
  },
  {
    host: 'portal',
    names:
      /\b(?:portal|dashboard|console\.|app store connect|developer\.apple|github\.com\/settings|cloudflare|1password\.com)\b/i,
  },
]

/** Where the hands must be, from what the request says; `any` when it names nothing. */
export function hostOf(text: string): Host {
  for (const { host, names } of WHERE) if (names.test(text)) return host
  return 'any'
}
