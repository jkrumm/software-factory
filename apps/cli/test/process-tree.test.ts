import { describe, expect, test } from 'bun:test'
import { parseCpuTime, parsePsTree, treeMeter, treeOf } from '../src/process-tree.ts'

describe('parseCpuTime', () => {
  test('reads m:ss, mm:ss.xx, h:mm:ss and d-hh:mm:ss', () => {
    expect(parseCpuTime('0:00.00')).toBe(0)
    expect(parseCpuTime('1:05')).toBe(65)
    expect(parseCpuTime('12:34.50')).toBe(754.5)
    expect(parseCpuTime('2:01:01')).toBe(7261)
    expect(parseCpuTime('1-00:00:30')).toBe(86_430)
  })
  test('refuses what is not a time', () => {
    expect(parseCpuTime('')).toBeNull()
    expect(parseCpuTime('abc')).toBeNull()
    expect(parseCpuTime('12')).toBeNull()
  })
})

const listing = `
    1     0   9000   0:10.00
  100     1   2048   0:01.50
  101   100   4096   0:02.00
  102   101   1024   1:00.25
  200     1  50000   5:00.00
garbage line
  300   100   x      0:01
`

describe('ps tree', () => {
  test('parses the rows and skips what does not parse', () => {
    expect(parsePsTree(listing).map((r) => r.pid)).toEqual([1, 100, 101, 102, 200])
  })

  test('the tree is the root and every descendant, nothing else', () => {
    expect(
      treeOf(parsePsTree(listing), 100)
        .map((r) => r.pid)
        .sort(),
    ).toEqual([100, 101, 102])
    expect(treeOf(parsePsTree(listing), 999)).toEqual([])
  })

  test('the meter sums KiB to MiB, keeps the peak, and counts the most cpu seen per pid, also of a process that ended', () => {
    const meter = treeMeter(100)
    expect(meter.peakRssMib).toBeNull()
    meter.sample(parsePsTree(listing))
    expect(meter.rssMib).toBe(7)
    expect(meter.peakRssMib).toBe(7)
    expect(meter.cpuSeconds).toBe(63.75)
    // 102 ended, 101 grew its cpu; the size is lower now, the peak and 102's cpu stay
    meter.sample(parsePsTree('100 1 1024 0:02.00\n101 100 1024 0:03.00'))
    expect(meter.rssMib).toBe(2)
    expect(meter.peakRssMib).toBe(7)
    expect(meter.cpuSeconds).toBe(65.25)
  })
})
