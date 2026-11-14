import { CpuIcon, GraphIcon, KanbanIcon, LightningIcon, TrendUpIcon, type Icon } from '@phosphor-icons/react'

export const NAV = [
  { to: '/needs-you', label: 'Needs you', icon: LightningIcon, key: 'N' },
  { to: '/flow', label: 'Flow', icon: KanbanIcon, key: 'F' },
  { to: '/chain', label: 'Chain', icon: GraphIcon, key: 'C' },
  { to: '/improve', label: 'Improve', icon: TrendUpIcon, key: 'I' },
  { to: '/throughput', label: 'Throughput', icon: CpuIcon, key: 'T' },
] as const satisfies ReadonlyArray<{ to: string; label: string; icon: Icon; key: string }>

export type NavItem = (typeof NAV)[number]
