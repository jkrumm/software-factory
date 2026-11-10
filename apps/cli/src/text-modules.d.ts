/** Bun embeds a `with { type: 'text' }` import as a string at build time. */
declare module '*.md' {
  const text: string
  export default text
}
