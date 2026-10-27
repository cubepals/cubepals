// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The staging check's journey for a world a player brings (docs/world-import.md): a server's world,
 * marked, downloaded, and made into what a player has on their own computer, its world folder
 * alone in a zip, which a server's folder or a download is not. Uploaded to the server, it is read,
 * kept as a backup and restored, and the server then runs it, the same seed and the same mark.
 * The journey itself (its account, its server, its steps) is the check's (`staging-check.ts`).
 */
import { randomInt, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Api } from './people.ts'

/** What of the check's journey this one uses. */
export interface WorldJourney {
  api: Api
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

export async function bringsWorldIn(j: WorldJourney): Promise<void> {
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
}
