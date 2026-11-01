/** A URL inside running text: a scheme, then everything up to the next space or quote. Linear: no nested repetition. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s"'<>`]+/gi
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i

/** `scheme://user:password@host` without the user and the password. */
export const withoutUserinfo = (url: string): string => url.replace(USERINFO, '$1')

/**
 * Text from an alert as it may leave the parser: every URL in it loses its userinfo, its query string and its fragment (a DSN, a
 * connection error, a webhook URL carry credentials there), and keeps its scheme, host and path. Applying it twice changes nothing.
 */
export function redactUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (url) => {
    const bare = withoutUserinfo(url)
    const at = bare.search(/[?#]/)
    return at < 0 ? bare : `${bare.slice(0, at)}${bare.charAt(at)}[redacted]`
  })
}
