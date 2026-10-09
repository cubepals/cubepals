import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

// A console that opens mid-game shows what came before (§13): the server's recent output,
// classified the way the live tail is.
describe.skipIf(!hasDatabase)('console history', () => {
  let h: Harness

  beforeAll(async () => {
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
  })

  test('the last lines a running server printed, newest last, as the console shows them', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)

    const lines = await h.app.feed.recent(created.id, 50)
    expect(lines.map((l) => l.text)).toContain('Done (0.100s)! For help, type "help"')
    expect(
      lines.every(
        (l) => l.at instanceof Date && ['info', 'warn', 'error', 'chat', 'setup'].includes(l.level),
      ),
    ).toBe(true)
    // The image's own bootstrap is marked as Blockly's work rather than read as the game's.
    expect(lines.filter((l) => l.level === 'setup').map((l) => l.text)).toContain(
      '[init] Starting the Minecraft server...',
    )
    // Newest last, and no more than asked for.
    const times = lines.map((l) => l.at.getTime())
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(await h.app.feed.recent(created.id, 1)).toHaveLength(1)
  }, 30_000)

  test('a server with no workload has no history', async () => {
    const owner = await h.user()
    const created = await h.create(owner)
    await h.until(created.id, 'running')
    await h.settled(created.id)
    await h.app.servers.deleteServer(owner, created.id, created.name)
    await h.settled(created.id)
    await h.db
      .update(schema.serverRuntimes)
      .set({ handle: null })
      .where(eq(schema.serverRuntimes.serverId, created.id))
    expect(await h.app.feed.recent(created.id, 50)).toEqual([])
  }, 30_000)
})
