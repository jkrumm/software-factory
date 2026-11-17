import {
  CpuIcon,
  FileTextIcon,
  FolderSimpleIcon,
  GraphIcon,
  LightningIcon,
  SquaresFourIcon,
  TrendUpIcon,
  type Icon,
} from '@phosphor-icons/react'
import { SCREENS, type ScreenTarget } from './screens.ts'

const ICON = {
  '/': SquaresFourIcon,
  '/needs-you': LightningIcon,
  '/chain': GraphIcon,
  '/projects': FolderSimpleIcon,
  '/artifacts': FileTextIcon,
  '/improve': TrendUpIcon,
  '/throughput': CpuIcon,
} as const satisfies Record<ScreenTarget, Icon>

/** The screens of `screens.ts` with their icons, in the navigation's order. */
export const NAV = SCREENS.map((screen) => ({ ...screen, icon: ICON[screen.to] }))

export type NavItem = (typeof NAV)[number]

/** The daily screens, then the quieter group (Improve, Throughput). */
export const NAV_GROUPS = [
  { key: 'work', items: NAV.filter((item) => item.group === 'work') },
  { key: 'insight', items: NAV.filter((item) => item.group === 'insight') },
] as const
