import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makefileMergeGuard } from '../../src/adapters/git/merge-guard.ts'

test('a Makefile with a merge-guard rule has one, one without or no Makefile has none', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'merge-guard-'))
  try {
    const guard = makefileMergeGuard()
    expect(await guard.has(dir)).toBe(false)
    await writeFile(join(dir, 'Makefile'), '.PHONY: check\ncheck:\n\t@echo merge-guard is not a target\n')
    expect(await guard.has(dir)).toBe(false)
    await writeFile(join(dir, 'Makefile'), 'check:\n\ttrue\n\nmerge-guard:\n\t@bun scripts/merge-guard.ts\n')
    expect(await guard.has(dir)).toBe(true)
    await writeFile(join(dir, 'Makefile'), 'MERGE_GUARD := 1\nci merge-guard: check\n\ttrue\n')
    expect(await guard.has(dir)).toBe(true)
    await writeFile(join(dir, 'Makefile'), 'include mk/guard.mk\ncheck:\n\ttrue\n')
    expect(await guard.has(dir)).toBeNull()
    await writeFile(join(dir, 'Makefile'), 'sinclude mk/guard.mk\ncheck:\n\ttrue\n')
    expect(await guard.has(dir)).toBeNull()
    // make reads GNUmakefile before Makefile
    await writeFile(join(dir, 'GNUmakefile'), 'merge-guard:\n\t@true\n')
    expect(await guard.has(dir)).toBe(true)
    await writeFile(join(dir, 'GNUmakefile'), 'check:\n\ttrue\n')
    expect(await guard.has(dir)).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
