import { expect, type Page } from '@playwright/test'

/**
 * The text of the page without the "Since you were here" band: its rows carry the Issue number (`#657`) beside the title,
 * which is the one place on Needs you where a number is meant to show, so a check that no id leaks reads the rest.
 *
 * The band holds its height as a skeleton while it loads (under the same heading), so it is read once it has arrived, and
 * it is found, hidden, read and restored in one synchronous step in the page: the band can mount (or the screen remount
 * it) between two separate calls, and a count taken in one said nothing about the text read in the next.
 */
export async function textWithoutBand(page: Page): Promise<string> {
  const band = page.getByRole('region', { name: 'Since you were here' })
  const quiet = page.getByText(/^Nothing changed since you were here/)
  await expect(band.or(quiet).first()).toBeVisible()
  await expect(band.locator('.animate-pulse')).toHaveCount(0)
  return page.locator('body').evaluate((body) => {
    const heading = [...body.querySelectorAll('h2')].find((h) => h.textContent === 'Since you were here')
    const section = heading?.closest('section') ?? null
    const shown = section?.style.display ?? ''
    if (section) section.style.display = 'none'
    const text = body.innerText
    if (section) section.style.display = shown
    return text
  })
}
