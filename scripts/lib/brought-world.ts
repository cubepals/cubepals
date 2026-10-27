// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The staging check's journey for a world a player brings (docs/world-import.md): a server's world,
 * marked, downloaded, and made into what a player has on their own computer, its world folder
 * alone in a zip, which a server's folder or a download is not. Uploaded to the server, it is read,
 * kept as a backup and restored, and the server then runs it, the same seed and the same mark.
 * Brought again while a new server is made, the new server starts on it, the same again. The
 * journey itself (its account, its server, its steps) is the check's (`staging-check.ts`).
 */
import { randomInt, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Api } from './people.ts'

/** What of the check's journey this one uses. */
export interface WorldJourney {
  api: Api
  owner: { email: string }
  server: { id: string }
  step(name: string, run: () => Promise<string | undefined>, limitSeconds?: number): Promise<void>
  // biome-ignore lint/suspicious/noExplicitAny: servers.get, read loosely as the check reads it
  waitFor(want: (v: any) => boolean, what: string, limit?: number): Promise<any>
  settled(limit?: number): Promise<unknown>
  consoleSays(command: string): Promise<string>
  seedOf(): Promise<string>
}

/** A command line run to its end, failing with what it said. */
async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stderr: 'pipe' })
  if ((await child.exited) !== 0) throw new Error(`${command[0]}: ${await new Response(child.stderr).text()}`)
}

/** Waits for a backup the list shows to be ready, and hands it back. */
async function readyBackup(
  j: WorldJourney,
  which: (b: { id: string; trigger: string; tier: string; status: string }) => boolean,
  seconds: number,
) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const { backups } = await j.api('backups.list', { serverId: j.server.id }, 'GET')
    const found = (backups as Array<{ id: string; trigger: string; tier: string; status: string }>).find(
      which,
    )
    if (found?.status === 'failed') throw new Error(`the ${found.tier} failed`)
    if (found?.status === 'ready') return found
    await Bun.sleep(3000)
  }
  throw new Error(`no backup was ready within ${seconds}s`)
}

export async function bringsWorldIn(
  j: WorldJourney,
  sql: (statement: string) => Promise<string>,
): Promise<void> {
  const mark = String(randomInt(1, 1_000_000))
  const markOf = async () =>
    (await j.consoleSays('scoreboard players get check blockly_check')).match(/has (-?\d+)/)?.[1] ?? ''
  let seed = ''
  let save: Uint8Array | null = null

  await j.step(
    'its world, marked and downloaded, becomes a save of its own: its folder in a zip',
    async () => {
      seed = await j.seedOf()
      await j.consoleSays('scoreboard objectives add blockly_check dummy')
      await j.consoleSays(`scoreboard players set check blockly_check ${mark}`)
      await j.consoleSays('save-all flush')
      await j.api('backups.create', { serverId: j.server.id, requestId: randomUUID() })
      const snapshot = await readyBackup(j, (b) => b.trigger === 'manual' && b.tier === 'snapshot', 600)
      await j.api('backups.archive', {
        serverId: j.server.id,
        backupId: snapshot.id,
        requestId: randomUUID(),
      })
      const archive = await readyBackup(j, (b) => b.tier === 'archive' && b.trigger === 'manual', 900)
      let download = await j.api('backups.download', { serverId: j.server.id, backupId: archive.id })
      while (download.status === 'making') {
        await Bun.sleep(3000)
        download = await j.api(
          'backups.downloadState',
          { serverId: j.server.id, backupId: archive.id },
          'GET',
        )
      }
      if (download.status !== 'ready') throw new Error(`the download ${download.status}: ${download.message}`)
      const dir = await mkdtemp(join(tmpdir(), 'brought-world-'))
      try {
        await Bun.write(join(dir, 'download.tar.gz'), await fetch(download.url))
        await run(['tar', '-xzf', 'download.tar.gz'], dir)
        await run(['mv', 'world', 'Staging World'], dir)
        await run(['zip', '-qr', 'Staging World.zip', 'Staging World'], dir)
        save = new Uint8Array(await readFile(join(dir, 'Staging World.zip')))
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
      return `seed ${seed}, mark ${mark}; the save is ${(save.length / 2 ** 20).toFixed(1)} MB`
    },
    1800,
  )
  if (save === null) return
  const bytes: Uint8Array = save

  let backupId = ''
  await j.step(
    'is uploaded, read and kept as a backup of the server',
    async () => {
      const start = await j.api('backups.beginUpload', {
        serverId: j.server.id,
        fileName: 'Staging World.zip',
        sizeBytes: bytes.length,
      })
      const put = await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
      if (!put.ok) throw new Error(`the store answered ${put.status} to the upload`)
      const { importId } = await j.api('backups.finishUpload', {
        serverId: j.server.id,
        ticket: start.ticket,
      })
      for (;;) {
        const read = await j.api('backups.upload', { serverId: j.server.id, importId }, 'GET')
        if (read.status === 'reading') {
          await Bun.sleep(2000)
          continue
        }
        if (read.status !== 'ready') throw new Error(`it is ${read.status}: ${JSON.stringify(read)}`)
        backupId = read.backupId
        return read.notes.join(' ')
      }
    },
    900,
  )
  if (backupId === '') return

  await j.step(
    'restored, the server runs it: the same seed and the same mark',
    async () => {
      await j.api('backups.restore', {
        serverId: j.server.id,
        requestId: randomUUID(),
        backupId,
        withConfiguration: false,
      })
      await j.waitFor(
        (v) => v.status === 'running' && v.activeOperation === null,
        'restored and running',
        1200,
      )
      const now = { seed: await j.seedOf(), mark: await markOf() }
      if (now.seed !== seed) throw new Error(`the seed was ${seed} and is ${now.seed}`)
      if (now.mark !== mark) throw new Error(`the mark was ${mark} and is ${now.mark}`)
      return `seed ${now.seed}, mark ${now.mark}`
    },
    1500,
  )

  await j.step(
    'brought while a server is made, the new server starts on it: the same seed and the same mark',
    async () => {
      // Free holds and runs one server, and this account's first is still running: it holds and
      // runs two for this step.
      const account = `user_id = (select id from users where email = '${j.owner.email}')`
      await sql(
        `update account_standing set limit_overrides = limit_overrides || '{"maxServers": 2, "maxRunning": 2}' where ${account}`,
      )
      try {
        return await madeFrom(j, bytes, { seed, mark }, sql)
      } finally {
        await sql(
          `update account_standing set limit_overrides = limit_overrides - 'maxServers' - 'maxRunning' where ${account}`,
        )
      }
    },
    1800,
  )
}

/** The save uploaded for a server not made yet, and read: what the create page picks. */
async function broughtForNew(j: WorldJourney, bytes: Uint8Array) {
  const start = await j.api('newWorlds.beginUpload', {
    fileName: 'Staging World.zip',
    sizeBytes: bytes.length,
  })
  const put = await fetch(start.url, { method: 'PUT', body: bytes, headers: start.headers })
  if (!put.ok) throw new Error(`the store answered ${put.status} to the upload`)
  const { importId } = await j.api('newWorlds.finishUpload', { ticket: start.ticket })
  let read = await j.api('newWorlds.upload', { importId }, 'GET')
  while (read.status === 'reading') {
    await Bun.sleep(2000)
    read = await j.api('newWorlds.upload', { importId }, 'GET')
  }
  if (read.status !== 'ready') throw new Error(`it is ${read.status}: ${JSON.stringify(read)}`)
  return read
}

/** A new server made from the save, up, asked its seed and mark, and sent to be purged. */
async function madeFrom(
  j: WorldJourney,
  bytes: Uint8Array,
  was: { seed: string; mark: string },
  sql: (statement: string) => Promise<string>,
): Promise<string> {
  const read = await broughtForNew(j, bytes)
  const created = await j.api('servers.create', {
    idempotencyKey: randomUUID(),
    name: 'Staging Check',
    partySize: '5',
    regionKey: 'eu',
    from: { kind: 'world', importId: read.importId },
  })
  try {
    const deadline = Date.now() + 900_000
    while ((await j.api('servers.get', { serverId: created.id }, 'GET')).status !== 'running') {
      if (Date.now() > deadline) throw new Error('the new server never came up')
      await Bun.sleep(3000)
    }
    const said = async (command: string) =>
      String((await j.api('console.run', { serverId: created.id, command })).output ?? '')
    const seed = (await said('seed')).match(/-?\d+/)?.[0] ?? ''
    const mark = (await said('scoreboard players get check blockly_check')).match(/has (-?\d+)/)?.[1] ?? ''
    if (seed !== was.seed) throw new Error(`the seed was ${was.seed} and is ${seed}`)
    if (mark !== was.mark) throw new Error(`the mark was ${was.mark} and is ${mark}`)
    return `${read.world.name} on Minecraft ${read.world.playsOn}: seed ${seed}, mark ${mark}`
  } finally {
    await purgedNow(j, created.id, sql)
  }
}

/** A server the journey made besides its own, to the trash and purged at once. */
async function purgedNow(j: WorldJourney, serverId: string, sql: (statement: string) => Promise<string>) {
  await j.api('servers.delete', { serverId, confirmName: 'Staging Check' }).catch(() => undefined)
  for (const until = Date.now() + 300_000; Date.now() < until; await Bun.sleep(3000)) {
    const seen = await j.api('servers.get', { serverId }, 'GET').catch(() => null)
    if (seen === null || (seen.status === 'deleted' && seen.activeOperation === null)) break
  }
  await sql(`update minecraft_servers set purge_after = now() where id = '${serverId}'`).catch(() => '')
}
