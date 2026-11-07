/** A URL inside running text: a scheme, then everything up to the next space or quote. Linear: no nested repetition. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s"<>`]+/gi
/** A path segment that looks like a secret (a Slack webhook's, an API key in the path): long, and only token characters. */
const SECRET_SEGMENT = /(\/)[A-Za-z0-9_-]{24,}(?=\/|$)/g
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i

/** `scheme://user:password@host` without the user and the password. */
export const withoutUserinfo = (url: string): string => url.replace(USERINFO, '$1')

/**
 * Text from an alert as it may leave the parser: every URL in it loses its userinfo, its query string and its fragment (a DSN, a
 * connection error, a webhook URL carry credentials there), and keeps its scheme, host and path, except a path segment of 24 or
 * more token characters, which is a secret more often than a name (a Slack webhook's). Applying it twice changes nothing.
 */
export function redactUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (found) => {
    // A quote that closes the URL in the text is not part of it (one inside the userinfo still is).
    const quotes = /'+$/.exec(found)?.[0] ?? ''
    const url = withoutUserinfo(found.slice(0, found.length - quotes.length))
    const at = url.search(/[?#]/)
    const path = (at < 0 ? url : url.slice(0, at)).replace(SECRET_SEGMENT, '$1[redacted]')
    return `${path}${at < 0 ? '' : `${url.charAt(at)}[redacted]`}${quotes}`
  })
}
