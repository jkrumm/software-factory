import {
  CpuIcon,
  FileTextIcon,
  FolderSimpleIcon,
  GraphIcon,
  ChartLineIcon,
  LightningIcon,
  TrendUpIcon,
  type Icon,
} from '@phosphor-icons/react'

export const NAV = [
  { to: '/needs-you', label: 'Needs you', icon: LightningIcon, key: 'N' },
  { to: '/flow', label: 'Flow', icon: ChartLineIcon, key: 'F' },
  { to: '/artifacts', label: 'Artifacts', icon: FileTextIcon, key: 'A' },
  { to: '/projects', label: 'Projects', icon: FolderSimpleIcon, key: 'P' },
  { to: '/chain', label: 'Chain', icon: GraphIcon, key: 'C' },
  { to: '/improve', label: 'Improve', icon: TrendUpIcon, key: 'I' },
  { to: '/throughput', label: 'Throughput', icon: CpuIcon, key: 'T' },
] as const satisfies ReadonlyArray<{ to: string; label: string; icon: Icon; key: string }>

export type NavItem = (typeof NAV)[number]
