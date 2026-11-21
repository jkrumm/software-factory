/**
 * `<details><summary>…</summary> … </details>` in a Markdown artifact: a Spec fits a page by folding its detail away, and
 * react-markdown drops raw HTML, so the three tags are read here and become real elements (`details`, `summary`) that the
 * reader opens on a click. Nothing else of the raw HTML survives: only these tags, and `open` on the first of them.
 */

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

const TAG = /<details\b([^>]*)>|<summary\b[^>]*>([\s\S]*?)<\/summary>|<\/details>/gi

const block = (open: boolean): MdNode => ({
  type: 'details',
  children: [],
  data: { hName: 'details', hProperties: open ? { open: true } : {} },
})

const summaryOf = (text: string): MdNode => ({
  type: 'summary',
  data: { hName: 'summary' },
  children: [
    {
      type: 'text',
      value: text
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    },
  ],
})

/** Wraps what stands between a `<details>` and its `</details>` (blocks of the same parent) into one `details` node. */
function fold(parent: MdNode): void {
  const kids = parent.children
  if (!kids) return
  const root: MdNode[] = []
  const stack: MdNode[] = []
  const into = (node: MdNode) => {
    const top = stack.at(-1)
    if (top) top.children?.push(node)
    else root.push(node)
  }
  for (const kid of kids) {
    if (kid.type !== 'html') {
      fold(kid)
      into(kid)
      continue
    }
    const source = kid.value ?? ''
    let from = 0
    // the words between the tags of one html node (no blank line after the summary) belong to the block they sit in
    const words = (to: number) => {
      const text = source.slice(from, to).trim()
      if (text !== '' && stack.length > 0) into({ type: 'paragraph', children: [{ type: 'text', value: text }] })
    }
    for (const tag of source.matchAll(TAG)) {
      const [whole, attributes, summary] = tag
      words(tag.index)
      from = tag.index + whole.length
      if (summary !== undefined) {
        const top = stack.at(-1)
        if (top && !top.children?.some((child) => child.type === 'summary')) top.children?.unshift(summaryOf(summary))
      } else if (whole.startsWith('</')) {
        const closed = stack.pop()
        if (closed) into(closed)
      } else {
        stack.push(block(/\bopen\b/i.test(attributes ?? '')))
      }
    }
    words(source.length)
  }
  // a block left open at the end of its parent closes there
  while (stack.length > 0) {
    const closed = stack.pop()
    if (closed) into(closed)
  }
  parent.children = root
}

/** The remark plugin: `remarkPlugins={[remarkDetails]}`. */
export function remarkDetails() {
  return (tree: MdNode) => fold(tree)
}
