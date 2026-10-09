/**
 * What a day costs, as the spend watchdog works it out (docs/money-guards.md): Fly's prices by
 * size, the part of each run inside the day, stray compute and disks, rounding up, and the limit
 * at and one cent past it. The watchdog acting on it is `app/operations/spend-watchdog.test.ts`'s.
 */
import { describe, expect, test } from 'bun:test'
import { daySpend, dollars, HOUR_CENTS, hoursWithin, overLimit, UNKNOWN_HOUR_CENTS, utcDay } from './spend.ts'

const at = (time: string) => new Date(`2026-10-03T${time}Z`)
const from = at('00:00:00')
/** The whole of 3 October. */
const day = (patch: Partial<Parameters<typeof daySpend>[0]> = {}) =>
  daySpend({ from, to: new Date(from.getTime() + 24 * 3_600_000), runs: [], stray: [], diskGb: 0, ...patch })

// What a day costs, as the spend watchdog works it out (docs/money-guards.md).
describe('a day’s spend', () => {
  test('Fly’s Frankfurt prices by size, the dearest for a size nobody recorded', () => {
    expect(HOUR_CENTS['3g']).toBe(6.25)
    expect(HOUR_CENTS['4g']).toBe(10.6)
    expect(HOUR_CENTS['8g']).toBe(21.2)
    // A size no longer sold costs what its machine does, never less.
    expect(HOUR_CENTS['2g']).toBe(HOUR_CENTS['3g'])
    expect(HOUR_CENTS['6g']).toBe(HOUR_CENTS['8g'])
    expect(UNKNOWN_HOUR_CENTS).toBe(21.2)
  })

  test('only the part of a run inside the day counts, and an open run counts up to now', () => {
    const now = at('12:00:00')
    // Started yesterday evening, stopped at 02:00: two hours of today.
    expect(
      hoursWithin({ startedAt: new Date('2026-10-02T20:00:00Z'), stoppedAt: at('02:00:00') }, from, now),
    ).toBe(2)
    // Still running: from 10:00 to now.
    expect(hoursWithin({ startedAt: at('10:00:00'), stoppedAt: null }, from, now)).toBe(2)
    // Over before the day began, or not begun by now.
    expect(hoursWithin({ startedAt: new Date('2026-10-02T01:00:00Z'), stoppedAt: from }, from, now)).toBe(0)
    expect(hoursWithin({ startedAt: at('13:00:00'), stoppedAt: null }, from, now)).toBe(0)
  })

  test('the default caps’ worst case: ten small servers all day is about $15', () => {
    const to = new Date(from.getTime() + 24 * 3_600_000)
    const runs = Array.from({ length: 10 }, () => ({ tier: '3g', startedAt: from, stoppedAt: null }))
    expect(daySpend({ from, to, runs, stray: [], diskGb: 0 }).cents).toBe(1500)
    // The same ten on the large size is four times that bound, which only Plus can buy.
    const large = runs.map((r) => ({ ...r, tier: '8g' }))
    expect(daySpend({ from, to, runs: large, stray: [], diskGb: 0 }).cents).toBe(5088)
  })

  test('compute nobody accounts for is priced from when it was seen to start, at its size or the dearest', () => {
    const now = at('12:00:00')
    const spend = daySpend({
      from,
      to: now,
      runs: [],
      stray: [
        { tier: '3g', since: at('10:00:00') },
        { tier: null, since: new Date('2026-10-01T00:00:00Z') },
      ],
      diskGb: 0,
    })
    // Two small hours, and twelve of the dearest: what it ran before today was yesterday's.
    expect(spend.strayCents).toBe(Math.ceil(2 * 6.25 + 12 * 21.2))
    expect(spend.computeCents).toBe(0)
  })

  test('disks cost by the hour they are held, and every part rounds up so the total never reads low', () => {
    const spend = day({ diskGb: 73, runs: [{ tier: '3g', startedAt: from, stoppedAt: at('00:01:00') }] })
    // 73 GB for a day is 15¢ × 73 / 730 × 24 = 36¢; a minute of compute is a fraction, so a cent.
    expect(spend.storageCents).toBe(36)
    expect(spend.computeCents).toBe(1)
    expect(spend.cents).toBe(spend.computeCents + spend.strayCents + spend.storageCents)
  })

  test('the limit itself may be spent; a cent past it trips', () => {
    const spent = (cents: number) => ({ computeCents: cents, strayCents: 0, storageCents: 0, cents })
    expect(overLimit(spent(999), 1000)).toBe(false)
    expect(overLimit(spent(1000), 1000)).toBe(false)
    expect(overLimit(spent(1001), 1000)).toBe(true)
    // A limit of nothing pauses at the first cent.
    expect(overLimit(spent(0), 0)).toBe(false)
    expect(overLimit(spent(1), 0)).toBe(true)
  })

  test('a day is the UTC day, and money reads as dollars', () => {
    expect(utcDay(new Date('2026-10-03T23:59:59Z'))).toEqual({ from, day: '2026-10-03' })
    expect(utcDay(new Date('2026-10-04T00:00:00Z')).day).toBe('2026-10-04')
    expect(dollars(1001)).toBe('$10.01')
  })
})
