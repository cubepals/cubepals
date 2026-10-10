/**
 * What the staging check prints while it waits and when it ends: progress lines paced on a clock
 * the test moves, and the summary table.
 */
import { describe, expect, test } from 'bun:test'
import { clock, Progress, progressLine, summaryTable } from './check-progress.ts'

/** A Progress on a clock the test moves, and the lines it printed. */
function rig() {
  let now = 1_000_000
  const lines: string[] = []
  const progress = new Progress({ write: (line) => lines.push(line), everyMs: 20_000, now: () => now })
  const at = (seconds: number) => {
    now = 1_000_000 + seconds * 1000
    progress.tick()
  }
  return { progress, lines, at }
}

describe('check progress', () => {
  test('time into a step reads as a clock', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(5_400)).toBe('0:05')
    expect(clock(607_200)).toBe('10:07')
    expect(clock(3_723_000)).toBe('1:02:03')
  })

  test('a line is plain text under the step, its time right-aligned', () => {
    expect(progressLine(42_000, 'now: server stopping')).toBe('  ..    0:42  now: server stopping')
    expect(progressLine(607_000, 'x')).toBe('  ..   10:07  x')
    expect(progressLine(0, 'x')).not.toContain('\r')
  })

  test('a step over before the first line is due prints nothing', () => {
    const { progress, lines, at } = rig()
    progress.begin()
    progress.waiting('settled')
    progress.saw('server running')
    progress.saw('server running, stop: stopping')
    at(19)
    progress.end()
    at(60)
    expect(lines).toEqual([])
  })

  test('a long wait says what it waits for, then each change at once, then again when quiet', () => {
    const { progress, lines, at } = rig()
    progress.begin()
    progress.waiting('went to sleep')
    progress.saw('server running | Fly: started')
    at(10)
    at(20)
    progress.saw('server running | Fly: started')
    at(30)
    at(41)
    at(61)
    at(64)
    progress.saw('server stopping, stop: stopping | Fly: started')
    at(70)
    at(84)
    progress.saw('server stopped (idle) | Fly: stopped')
    progress.end()
    at(200)
    expect(lines).toEqual([
      '  ..    0:20  waiting for "went to sleep"; server running | Fly: started',
      '  ..    0:41  waiting for "went to sleep"; server running | Fly: started',
      '  ..    1:01  waiting for "went to sleep"; server running | Fly: started',
      '  ..    1:04  now: server stopping, stop: stopping | Fly: started',
      '  ..    1:24  waiting for "went to sleep"; server stopping, stop: stopping | Fly: started',
      '  ..    1:24  now: server stopped (idle) | Fly: stopped',
    ])
  })

  test('a wait with nothing seen yet still says it is waiting', () => {
    const { progress, lines, at } = rig()
    progress.begin()
    at(25)
    progress.waiting('purged')
    at(50)
    expect(lines).toEqual(['  ..    0:25  working', '  ..    0:50  waiting for "purged"'])
  })

  test('each step starts quiet, whatever the one before printed', () => {
    const { progress, lines, at } = rig()
    progress.begin()
    progress.waiting('woke')
    at(30)
    progress.end()
    progress.begin()
    progress.saw('server running')
    at(45)
    expect(lines).toEqual(['  ..    0:30  waiting for "woke"'])
  })
})

describe('summary table', () => {
  test('one aligned line a step, then the total with how many held', () => {
    const table = summaryTable(
      [
        { name: 'is made on Fly and comes up', ok: true, ms: 83_400 },
        { name: 'goes to sleep on its own when nobody plays', ok: true, ms: 76_250 },
        { name: 'is the same world', ok: false, ms: 1_200 },
      ],
      1_020_500,
    )
    expect(table).toEqual([
      '  step                                        result      took',
      '  is made on Fly and comes up                 ok         83.4s',
      '  goes to sleep on its own when nobody plays  ok         76.3s',
      '  is the same world                           FAIL        1.2s',
      '  total                                                1020.5s  2 ok, 1 failed',
    ])
  })

  test('a run where everything held says so, and an empty run still has its total', () => {
    expect(summaryTable([{ name: 'a', ok: true, ms: 0 }], 0).at(-1)).toBe('  total              0.0s  1 ok')
    expect(summaryTable([], 0)).toEqual(['  step   result      took', '  total              0.0s  0 ok'])
  })
})
