import * as z from 'zod'

/** `config/infra.json`: the thresholds of the Beszel source and where each host's Issues go. Every number is a field; a host overrides any. */
const pos = z.number().positive()
const minutes = z.number().int().positive()

const shapes = {
  memory: { pct: pos.max(100), sustainMin: minutes, clearMin: minutes },
  swap: { usedGb: pos, sustainMin: minutes, clearMin: minutes },
  swap_growth: { windowMin: minutes, medianN: minutes, growthGb: pos, minGb: pos, clearMin: minutes },
  disk: {
    pct: pos.max(100),
    sustainMin: minutes,
    clearMin: minutes,
    windowMin: minutes,
    medianN: minutes,
    fillHours: pos,
    growthGbPerHour: pos,
    minPct: pos.max(100),
  },
  load: { perThread: pos, fallbackAbsolute: pos, sustainMin: minutes, clearMin: minutes },
  silent: { staleMin: minutes, clearMin: minutes },
}

type Shapes = typeof shapes
export type Thresholds = { [K in keyof Shapes]: { [F in keyof Shapes[K]]: number } }
type Override = { [K in keyof Shapes]?: Partial<Thresholds[K]> }

/** What the file says when it says nothing: the numbers of `docs/design.md` §8 "Beszel". */
export const DEFAULT_THRESHOLDS: Thresholds = {
  memory: { pct: 92, sustainMin: 15, clearMin: 10 },
  swap: { usedGb: 8, sustainMin: 10, clearMin: 10 },
  swap_growth: { windowMin: 120, medianN: 10, growthGb: 2, minGb: 1, clearMin: 10 },
  disk: {
    pct: 90,
    sustainMin: 10,
    clearMin: 10,
    windowMin: 120,
    medianN: 10,
    fillHours: 24,
    growthGbPerHour: 0.5,
    minPct: 50,
  },
  load: { perThread: 3, fallbackAbsolute: 20, sustainMin: 15, clearMin: 10 },
  silent: { staleMin: 10, clearMin: 10 },
}
export const DEFAULT_REFILE_AFTER_MIN = 360

const OverrideSchema = z.strictObject({
  memory: z.strictObject(shapes.memory).partial().optional(),
  swap: z.strictObject(shapes.swap).partial().optional(),
  swap_growth: z.strictObject(shapes.swap_growth).partial().optional(),
  disk: z.strictObject(shapes.disk).partial().optional(),
  load: z.strictObject(shapes.load).partial().optional(),
  silent: z.strictObject(shapes.silent).partial().optional(),
})

const REPO_NAME = /^(?!\.+$)[A-Za-z0-9._-]+$/

const InfraFile = z.strictObject({
  refileAfterMin: minutes.default(DEFAULT_REFILE_AFTER_MIN),
  defaults: OverrideSchema.default({}),
  hosts: z.record(
    z.string().regex(/^[a-z0-9._-]+$/, 'a host name is the lower-case Beszel system name'),
    z.strictObject({
      repo: z.string().regex(REPO_NAME, 'a directory name under SourceRoot'),
      local: z.boolean().optional(),
      thresholds: OverrideSchema.optional(),
    }),
  ),
})

export interface HostRule {
  repo: string
  local: boolean
  thresholds: Thresholds
}

export interface Infra {
  refileAfterMin: number
  /** by lower-case Beszel system name */
  hosts: ReadonlyMap<string, HostRule>
}

function merge(base: Thresholds, over: Override | undefined): Thresholds {
  return {
    memory: { ...base.memory, ...over?.memory },
    swap: { ...base.swap, ...over?.swap },
    swap_growth: { ...base.swap_growth, ...over?.swap_growth },
    disk: { ...base.disk, ...over?.disk },
    load: { ...base.load, ...over?.load },
    silent: { ...base.silent, ...over?.silent },
  }
}

export function parseInfra(text: string): Infra {
  const file = InfraFile.safeParse(JSON.parse(text))
  if (!file.success) {
    throw new Error(file.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`).join('; '))
  }
  const defaults = merge(DEFAULT_THRESHOLDS, file.data.defaults)
  const hosts = new Map<string, HostRule>()
  for (const [name, host] of Object.entries(file.data.hosts)) {
    hosts.set(name, { repo: host.repo, local: host.local === true, thresholds: merge(defaults, host.thresholds) })
  }
  return { refileAfterMin: file.data.refileAfterMin, hosts }
}
