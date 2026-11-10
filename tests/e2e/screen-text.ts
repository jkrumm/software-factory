import type { Page } from '@playwright/test'

/**
 * The text of the page without the "Since you were here" band: its rows carry the Issue number (`#657`) beside the title,
 * which is the one place on Needs you where a number is meant to show, so a check that no id leaks reads the rest.
 */
export async function textWithoutBand(page: Page): Promise<string> {
  const band = page.getByRole('region', { name: 'Since you were here' })
  const bandText = (await band.count()) > 0 ? await band.innerText() : ''
  const text = await page.locator('body').innerText()
  return bandText ? text.replace(bandText, '') : text
}
