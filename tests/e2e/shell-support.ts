import type { Page } from '@playwright/test'

export const chip = (page: Page) => page.getByRole('status').filter({ hasText: /Live|Polling|Offline|restarting/ })
export const badge = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByLabel(/\d+ waiting/)
