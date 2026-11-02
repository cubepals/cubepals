// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The staging journey distinguishes a cold wake before login from a slow join after login. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { ChangeAuthenticationInput, PowerInput } from '@blockly/contracts'
import { MINUTE_MS, SECOND_MS } from '@blockly/contracts/durations'
import { schema } from '@blockly/db'
import { eq, sql } from 'drizzle-orm'
import * as client from '../../../../scripts/lib/into-world.ts'
import { ownGameJoins } from '../../../../scripts/lib/own-game-joins.ts'
import { type Harness, hasDatabase, startHarness } from './harness.ts'

describe.skipIf(!hasDatabase)('own game staging joins', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)
  afterAll(async () => {
    await h.close()
  })

  test('a cold wake gets its startup budget while both measured joins keep the login limit', async () => {
    const { j, execute } = await journey(h)
    const limits: (number | undefined)[] = []
    const join = spyOn(client, 'intoWorld').mockImplementation(async (_edge, _address, _name, timeout) => {
      limits.push(timeout)
      const loggedInMs = limits.length === 3 ? 2 * MINUTE_MS : SECOND_MS
      return { loggedInMs, inWorldMs: loggedInMs + 3 * SECOND_MS }
    })
    try {
      expect(await ownGameJoins(j, { host: '127.0.0.1', port: 1 }, execute)).toBe(
        'in the world 3000ms after logging in awake, 3000ms woken by the join',
      )
      expect(join.mock.calls.every((call) => call[1] === j.address() && call[2] === 'StagingCheck')).toBe(
        true,
      )
      expect(limits).toEqual([undefined, undefined, 10 * MINUTE_MS])
      expect(j.timings).toEqual([3 * SECOND_MS, 3 * SECOND_MS])
      expect(
        (
          await h.db
            .select()
            .from(schema.publicListings)
            .where(eq(schema.publicListings.serverId, j.server.id))
        )[0]?.official,
      ).toBe(true)
    } finally {
      join.mockRestore()
    }
  }, 30_000)

  test('a slow join after login still refuses the journey', async () => {
    const { j, execute } = await journey(h)
    const join = spyOn(client, 'intoWorld').mockResolvedValue({
      loggedInMs: SECOND_MS,
      inWorldMs: 5 * SECOND_MS,
    })
    try {
      await expect(ownGameJoins(j, { host: '127.0.0.1', port: 1 }, execute)).rejects.toThrow('past 3.0s')
      expect(join).toHaveBeenCalledTimes(2)
    } finally {
      join.mockRestore()
    }
  }, 30_000)

  test('a cold wake still refuses a slow join after login', async () => {
    const { j, execute } = await journey(h)
    let joins = 0
    const join = spyOn(client, 'intoWorld').mockImplementation(async () => ({
      loggedInMs: 2 * MINUTE_MS,
      inWorldMs: 2 * MINUTE_MS + (++joins === 3 ? 4 * SECOND_MS : SECOND_MS),
    }))
    try {
      await expect(ownGameJoins(j, { host: '127.0.0.1', port: 1 }, execute)).rejects.toThrow(
        'woken by the join',
      )
      expect(join).toHaveBeenCalledTimes(3)
    } finally {
      join.mockRestore()
    }
  }, 30_000)
})

async function journey(h: Harness) {
  const owner = await h.user('Staging joins', 'plus')
  const server = await h.create(owner)
  await h.until(server.id, 'running')
  const timings: number[] = []
  const j = {
    server,
    timings,
    address: () => `${server.slug}.play.example.test`,
    timed: (_what: string, ms: number) => {
      timings.push(ms)
      return `${ms}ms`
    },
    api: async (path: string, input?: unknown) => {
      if (path === 'servers.changeAuthentication') {
        const request = ChangeAuthenticationInput.parse(input)
        await h.app.revisions.changeAuthentication(owner, server.id, request.onlineMode, request.requestId, {
          version: request.version,
          when: request.when,
        })
      } else if (path === 'servers.stop') {
        const request = PowerInput.parse(input)
        await h.app.servers.stop(owner, server.id, request.requestId)
      } else if (path !== 'servers.get') throw new Error(`Unexpected API ${path}`)
      return h.app.queries.get(owner, server.id)
    },
    waitFor: async (done: (view: Awaited<ReturnType<typeof h.app.queries.get>>) => boolean) => {
      const deadline = Date.now() + 10 * SECOND_MS
      while (Date.now() < deadline) {
        const view = await h.app.queries.get(owner, server.id)
        if (done(view)) return view
        await Bun.sleep(10)
      }
      throw new Error('The real server did not reach the requested state')
    },
  }
  const execute = async (statement: string) => {
    await h.db.execute(sql.raw(statement))
    return ''
  }
  return { j, execute }
}
