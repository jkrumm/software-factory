/** The language guide on GitHub: every domain word with its definition, in one page. */
export const GUIDE_URL = 'https://github.com/jkrumm/software-factory/blob/master/docs/language.md'

/** A hint holds two sentences; a definition that runs longer links to the guide for the rest. */
const HINT_SENTENCES = 2

/** Whether a definition has more than two sentences (a stop followed by a space or the end). */
export const needsGuide = (text: string): boolean => (text.match(/[.!?](?=\s|$)/g)?.length ?? 0) > HINT_SENTENCES
