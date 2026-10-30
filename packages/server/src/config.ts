export interface Config {
  databaseUrl: string
  herdrBin: string
  port: number
  version: string
}

/** Reads the environment once, at boot, and refuses to start on anything unusable. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const required = (name: string): string => {
    const value = env[name]
    if (!value) throw new Error(`${name} is not set`)
    return value
  }
  const port = Number(required('PORT'))
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got: ${env.PORT}`)
  }
  return {
    databaseUrl: required('DATABASE_URL'),
    herdrBin: required('HERDR_BIN'),
    port,
    version: env.FACTORY_VERSION || 'dev',
  }
}
