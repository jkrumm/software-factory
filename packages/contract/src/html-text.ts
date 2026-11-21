/** A page's named entities: the common ones, and the Latin-1 block a page writes by name. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '\u00b7',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  rarr: '\u2192',
  larr: '\u2190',
  bull: '\u2022',
  copy: '\u00a9',
  laquo: '\u00ab',
  raquo: '\u00bb',
  times: '\u00d7',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
  deg: '\u00b0',
  euro: '\u20ac',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
  check: '\u2713',
  cross: '\u2717',
  trade: '\u2122',
  harr: '\u2194',
  uarr: '\u2191',
  darr: '\u2193',
  rArr: '\u21d2',
  hArr: '\u21d4',
  ...Object.fromEntries(
    // the Latin-1 block, U+00A0 to U+00FF in order: the accented letters and symbols a page writes by name
    (
      'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro ' +
      'para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil ' +
      'Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave ' +
      'Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml ' +
      'igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute ' +
      'thorn yuml'
    )
      .split(' ')
      .map((name, i) => [name, String.fromCharCode(0xa0 + i)])
      // `nbsp` stays the space it is shown as
      .filter(([name]) => name !== 'nbsp'),
  ),
}

/** An entity as the browser shows it: named (the common ones), decimal or hex; anything else stays as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (entity, dec?: string, hex?: string, name?: string) => {
    if (name) return ENTITIES[name] ?? entity
    const code = dec ? Number(dec) : Number.parseInt(hex ?? '', 16)
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
}
