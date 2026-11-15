import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDoctorReader } from '../../src/adapters/doctor/index.ts'
import {
  DOCTOR_GREEN_RECHECK_MS,
  DOCTOR_RED_RECHECK_MS,
  describeDoctor,
  doctorDue,
  doctorMessage,
} from '../../src/domains/capacity/doctor.ts'

const base = mkdtempSync(join(tmpdir(), 'doctor-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let counter = 0
function repo(makefile: string): string {
  const dir = join(base, `repo-${++counter}`)
  mkdirSync(dir)
  writeFileSync(join(dir, 'Makefile'), makefile)
  return dir
}

const START = new Date('2026-11-15T12:00:00Z')
const after = (ms: number) => new Date(START.getTime() + ms)

describe('doctor model', () => {
  test('a reading stands for its kind of interval: red 5 minutes, green an hour', () => {
    const red = { ok: false, lines: ['x'], at: START }
    const green = { ok: true, lines: [], at: START }
    expect(doctorDue(undefined, START)).toBe(true)
    expect(doctorDue(red, after(DOCTOR_RED_RECHECK_MS - 1))).toBe(false)
    expect(doctorDue(red, after(DOCTOR_RED_RECHECK_MS))).toBe(true)
    expect(doctorDue(green, after(DOCTOR_RED_RECHECK_MS))).toBe(false)
    expect(doctorDue(green, after(DOCTOR_GREEN_RECHECK_MS))).toBe(true)
  })

  test('the message names the project and the first lines, counting the rest', () => {
    const lines = ['lab seed missing; fix: rsync it', 'no imagemagick; fix: brew install imagemagick']
    expect(doctorMessage('lab', { ok: false, lines, at: START })).toBe(
      `lab cannot run on this host: ${lines.join('; ')}`,
    )
    expect(describeDoctor(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('a; b; c; d; and 2 more')
    expect(doctorMessage('lab', { ok: false, lines: [], at: START })).toContain('exited non-zero')
  })
})

describe('doctor reader', () => {
  const read = (reader: ReturnType<typeof createDoctorReader>, dir: string) =>
    reader.read({ project: dir, repo: dir, command: 'make doctor' })

  test("exit 0 is green, any other exit is red with the output lines and none of make's own", async () => {
    const reader = createDoctorReader({ now: () => START })
    expect(await read(reader, repo('doctor:\n\t@exit 0\n'))).toEqual({ ok: true, lines: [], at: START })
    const red = await read(
      reader,
      repo(
        'doctor:\n\t@echo "seed missing; fix: rsync"\n\t@echo "no convert; fix: brew install imagemagick" >&2\n\t@exit 1\n',
      ),
    )
    expect(red).toEqual({
      ok: false,
      lines: ['seed missing; fix: rsync', 'no convert; fix: brew install imagemagick'],
      at: START,
    })
  })

  test('a Makefile without the target, or a doctor that hangs, is no reading', async () => {
    const reader = createDoctorReader({ now: () => START, timeoutMs: 300 })
    expect(await read(reader, repo('other:\n\t@true\n'))).toBeNull()
    expect(await read(reader, repo('doctor:\n\t@sleep 5\n'))).toBeNull()
    expect(
      await read(createDoctorReader({ now: () => START, make: '/nonexistent/make' }), repo('doctor:\n')),
    ).toBeNull()
  })

  test('a reading is kept until due, then the doctor runs again', async () => {
    let now = START
    const reader = createDoctorReader({ now: () => now })
    const dir = repo('doctor:\n\t@echo run >> runs.log; exit 1\n')
    const runs = () => Bun.file(join(dir, 'runs.log')).text()
    await read(reader, dir)
    await read(reader, dir)
    expect((await runs()).trim().split('\n')).toHaveLength(1)
    now = after(DOCTOR_RED_RECHECK_MS)
    await read(reader, dir)
    expect((await runs()).trim().split('\n')).toHaveLength(2)
  })

  test('two reads at once share one run', async () => {
    const reader = createDoctorReader({ now: () => START })
    const dir = repo('doctor:\n\t@echo run >> runs.log; sleep 0.3\n')
    await Promise.all([read(reader, dir), read(reader, dir)])
    expect((await Bun.file(join(dir, 'runs.log')).text()).trim().split('\n')).toHaveLength(1)
  })
})
