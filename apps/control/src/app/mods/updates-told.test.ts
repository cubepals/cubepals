// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The updates Cubepals found, said in the game to an operator as they join, with the link that
 * opens them on the Mods page: once a join, to operators alone, in the text format of the server's
 * Minecraft, and to the operator whose join woke the server.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { SECOND_MS } from '@blockly/contracts/durations'
import { stays, until } from '@blockly/contracts/waits'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { normalizeUuid as dashed, tellWithLink } from '../../minecraft/console.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'

const link = { text: 'Update on Cubepals', url: 'https://cubepals.com/servers/s/mods?update=all' }

test('the link is in the text format the server’s Minecraft reads', () => {
  const parts = (command: string) => JSON.parse(command.slice('tellraw Kai '.length)).extra.at(-1)
  expect(parts(tellWithLink('Kai', 'VeinMiner 2.13.1 is out.', link, '26.3'))).toMatchObject({
    text: ' Update on Cubepals',
    click_event: { action: 'open_url', url: link.url },
  })
  expect(parts(tellWithLink('Kai', 'VeinMiner 2.13.1 is out.', link, '1.21.5'))).toHaveProperty('click_event')
  expect(parts(tellWithLink('Kai', 'VeinMiner 2.13.1 is out.', link, '1.20.1'))).toMatchObject({
    clickEvent: { action: 'open_url', value: link.url },
  })
})

let h: Harness
const cdn = new Cdn()

/** A project on the catalog, its versions newest first. */
const publish = (projectId: string, ids: string[]) =>
  h.catalog.publish(
    {
      projectId,
      slug: projectId,
      name: projectId,
      summary: `${projectId}, for tests`,
      iconUrl: null,
      environments: ['server_only'],
      downloads: 1,
    },
    ids.map(
      (id, i): CatalogVersion => ({
        versionId: id,
        projectId,
        versionLabel: id,
        channel: 'release',
        state: 'listed',
        environment: 'server_only',
        loaders: ['fabric'],
        gameVersions: ['26.3'],
        publishedAt: new Date(Date.UTC(2026, 0, 1 + ids.length - i)),
        file: cdn.file(`${projectId}-${id}`),
        dependencies: [],
      }),
    ),
  )

describe.skipIf(!hasDatabase)('mod updates said in the game', () => {
  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  test('an operator who joins is told, with the link; once a join, and nobody else', async () => {
    publish('lantern', ['lantern-1'])
    const owner = await h.user('Alex', 'plus')
    const { id } = await h.create(owner, { loader: 'fabric' })
    await h.until(id, 'running')
    await h.settled(id)
    const change = { add: [{ projectId: 'lantern' }] }
    const plan = await h.app.mods.plan(owner, id, change)
    if (plan.kind !== 'ok') throw new Error('expected a plan')
    const before = await h.server(id)
    await h.app.mods.apply(
      owner,
      id,
      change,
      plan.mods.map((m) => m.artifact.sha512),
      randomUUID(),
    )
    await h.until(id, (s) => s.lifecycle.status === 'running' && s.version > before.version + 1, 20_000)
    await h.settled(id, 20_000)
    publish('lantern', ['lantern-2', 'lantern-1'])

    await h.app.access.add(owner, id, 'operator', 'Kai')
    await h.settled(id, 20_000)
    const profile = await h.profiles.byName('Kai')
    if (profile === null) throw new Error('expected Kai to have an account')
    const kai = { uuid: dashed(profile.uuid), name: profile.name }
    const ana = { uuid: randomUUID(), name: 'Ana' }
    const toldKai = () => h.minecraft.said(id).filter((line) => line.startsWith('to Kai: '))
    const told = () => h.minecraft.said(id).filter((line) => line.includes('lantern-2'))

    // Nobody on, then both join: only the operator is told.
    await h.app.schedules.presenceSync()
    h.minecraft.join(id, kai)
    h.minecraft.join(id, ana)
    await h.app.schedules.presenceSync()
    await until('the operator to be told', () => toldKai().length === 1, { seen: () => told().join('\n') })
    expect(told()).toEqual([
      'to Kai: [Cubepals] lantern lantern-2 is out. Cubepals checked it runs with your other mods. Update on Cubepals',
    ])
    const command = h.minecraft.heard(id).find((c) => c.startsWith('tellraw Kai '))
    expect(command).toContain(`http://localhost:3000/servers/${id}/mods?update=all`)

    // Still on at the next reading: not told again. Back after leaving: told again.
    await h.app.schedules.presenceSync()
    await stays('the operator told once', () => toldKai().length === 1, 2 * SECOND_MS)
    h.minecraft.leave(id, kai.uuid)
    await h.app.schedules.presenceSync()
    h.minecraft.join(id, kai)
    await h.app.schedules.presenceSync()
    await until('the operator to be told again', () => toldKai().length === 2, {
      seen: () => told().join('\n'),
    })
    expect(told().filter((line) => line.startsWith('to Ana: '))).toEqual([])

    // Stopped while they play, then woken by their join: they are on at its first reading, and told.
    await h.app.servers.stop(owner, id, randomUUID())
    await h.until(id, 'stopped')
    await h.settled(id)
    await h.app.servers.start(owner, id, randomUUID())
    await h.until(id, 'running')
    await h.settled(id)
    h.minecraft.join(id, kai)
    await h.app.schedules.presenceSync()
    await until('the operator who woke it to be told', () => toldKai().length === 3, {
      seen: () => told().join('\n'),
    })
  }, 60_000)
})
