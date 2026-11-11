import { expect, type Page } from '@playwright/test'

/**
 * The text of the page without the "Since you were here" band: its rows carry the Issue number (`#657`) beside the title,
 * which is the one place on Needs you where a number is meant to show, so a check that no id leaks reads the rest.
 *
 * The band holds its height as a skeleton while it loads (under the same heading), so it is read once it has arrived, and
 * the band is hidden for the one synchronous read of the page's text: a live update between two reads cannot leave part of
 * it in the text.
 */
export async function textWithoutBand(page: Page): Promise<string> {
  const band = page.getByRole('region', { name: 'Since you were here' })
  await expect(band.locator('.animate-pulse')).toHaveCount(0)
  if ((await band.count()) === 0) return page.locator('body').innerText()
  return band.evaluate((el) => {
    const shown = el.style.display
    el.style.display = 'none'
    const text = el.ownerDocument.body.innerText
    el.style.display = shown
    return text
  })
}
