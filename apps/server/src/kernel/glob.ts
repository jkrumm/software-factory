// Path globs as `project.yaml` writes them: a double star crosses directories (`a/**` is everything under `a/`, a leading
// double star plus slash also matches at the root), `*` and `?` stay inside one path segment. Anything else is literal. Pure, so a domain can read it.
const cache = new Map<string, RegExp>()

function compile(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i)
    if (char === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** Whether `path` (relative to the repo root, `/`-separated) is named by `glob`. */
export function globMatches(glob: string, path: string): boolean {
  let regex = cache.get(glob)
  if (!regex) {
    regex = compile(glob)
    cache.set(glob, regex)
  }
  return regex.test(path)
}
