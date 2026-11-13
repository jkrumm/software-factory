/**
 * What the factory holds is not for a child, which would pass its environment on: the one list of the secrets the server's
 * own environment carries, and the one way a child's environment is made from it. Both process adapters (`hc/process.ts`,
 * `quality/process.ts`) build their `childEnv` here.
 *
 * Every bearer token is on it, the agent token and the door's included: a child of the server (a `make verify`, a git hook, the
 * `hc` client) must not be able to call the API as a lead or post as the door. A lead gets its token on purpose, from the code that
 * starts it (`hc/terminals.ts` puts `FACTORY_TOKEN` into the terminal's own environment), never by inheritance. A test
 * (`test/secret-env.test.ts`) fails when a token setting of `settings.ts` is not on this list.
 */
export const SECRET_ENV: readonly string[] = [
  'FACTORY_TOKEN',
  'FACTORY_AGENT_TOKEN',
  'FACTORY_DOOR_TOKEN',
  'FACTORY_SIGNAL_TOKEN',
  'FACTORY_ORCHESTRATOR_TOKEN',
  'FACTORY_READ_TOKEN',
  'FACTORY_DB_PASSWORD',
  'DATABASE_URL',
  'FACTORY_GITHUB_TOKEN',
  'FACTORY_UPTIME_TOKEN',
  'NTFY_TOKEN',
]

/**
 * The server's environment without its secrets, then `extra` on top. A secret in `extra` is deliberate (the caller names it)
 * and reaches the child; one in the base never does.
 */
export function withoutSecrets(
  extra: Record<string, string> = {},
  base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base }
  for (const name of SECRET_ENV) delete env[name]
  return { ...env, ...extra }
}
