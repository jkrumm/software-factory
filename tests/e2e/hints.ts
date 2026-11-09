import type { Locator } from '@playwright/test'
import { LANGUAGE } from '../../apps/console/src/lib/language.gen.ts'
import { expect } from './fixtures.ts'

type Word = keyof typeof LANGUAGE

/** The InfoHint button of a domain word: its name is `What <Word> means`, the word capitalised as the popover titles it. */
export const hintOf = (scope: Locator, word: Word): Locator =>
  scope.getByRole('button', { name: `What ${word.charAt(0).toUpperCase()}${word.slice(1)} means`, exact: true })

/** One hint is in `scope`, and opening it shows the generated definition, never a retyped one. */
export async function expectHint(scope: Locator, word: Word): Promise<void> {
  const hint = hintOf(scope, word)
  await expect(hint, word).toHaveCount(1)
  await hint.scrollIntoViewIfNeeded()
  await hint.click()
  const popup = scope.page().getByRole('dialog')
  await expect(popup.filter({ hasText: LANGUAGE[word] }), word).toBeVisible()
  await scope.page().keyboard.press('Escape')
  await expect(popup).toHaveCount(0)
}
