// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import type { PublicPlan } from '@blockly/contracts'
import type { PlayerFaces } from '../../app/access/faces.ts'
import type { ItemIcons } from '../../app/items/icons.ts'
import type { ServerIcons } from '../../app/server-icons/service.ts'
import type { SharingQueries } from '../../app/sharing/queries.ts'
import { createPublicApp } from './public.ts'

// The pricing page reads the plans from here, signed in or not, so what it shows is the table
// that is enforced and never a copy of it.
describe('public sizes', () => {
  const app = createPublicApp({
    sharing: {} as SharingQueries,
    faces: {} as PlayerFaces,
    items: {} as ItemIcons,
    icons: {} as ServerIcons,
    platform: () => ({ unsoldPlans: [] }),
  })

  test('each answer to who is playing, with the players it holds and its memory', async () => {
    const response = await app.request('/api/public/sizes')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await response.json()).toEqual([
      { party: '5', maxPlayers: 5, memory: '3 GB' },
      { party: '10', maxPlayers: 10, memory: '4 GB' },
      { party: '20', maxPlayers: 20, memory: '8 GB' },
      { party: '50', maxPlayers: 50, memory: '8 GB' },
      { party: 'more', maxPlayers: 100, memory: '16 GB' },
    ])
  })
})

describe('public plans', () => {
  const app = createPublicApp({
    sharing: {} as SharingQueries,
    faces: {} as PlayerFaces,
    items: {} as ItemIcons,
    icons: {} as ServerIcons,
    platform: () => ({ unsoldPlans: [] }),
  })

  test('Free, Core and Plus, with what each costs and includes', async () => {
    const response = await app.request('/api/public/plans')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    const plans = (await response.json()) as PublicPlan[]
    expect(plans).toEqual([
      {
        key: 'free',
        name: 'Free trial',
        available: true,
        monthlyPriceCents: 0,
        yearlyPriceCents: null,
        // 20 hours in all, at most 2 a day from the player's midnight, and no monthly total.
        includedHours: 2,
        per: 'day',
        extraHourCents: null,
        totalHours: 20,
        sleepsAfterMinutes: 10,
        maxServers: 1,
        maxPlayers: 5,
        sizes: [{ gb: 3, maxPlayers: 5, hoursAnHour: 1 }],
        mods: false,
        datapacks: false,
        downloads: 'daily',
        sessionsKept: 3,
        restsAfterDays: 14,
        deletedAfterDays: 365,
      },
      {
        key: 'core',
        name: 'Core',
        available: true,
        monthlyPriceCents: 999,
        yearlyPriceCents: null,
        includedHours: 40,
        per: 'month',
        extraHourCents: 25,
        totalHours: null,
        sleepsAfterMinutes: 15,
        maxServers: 1,
        maxPlayers: 5,
        sizes: [{ gb: 3, maxPlayers: 5, hoursAnHour: 1 }],
        mods: false,
        datapacks: false,
        downloads: 'history',
        sessionsKept: 14,
        restsAfterDays: 30,
        deletedAfterDays: null,
      },
      {
        key: 'plus',
        name: 'Plus',
        available: true,
        monthlyPriceCents: 2500,
        yearlyPriceCents: 25000,
        includedHours: 120,
        per: 'month',
        extraHourCents: 25,
        totalHours: null,
        sleepsAfterMinutes: 15,
        maxServers: 3,
        maxPlayers: 100,
        sizes: [
          { gb: 3, maxPlayers: 5, hoursAnHour: 1 },
          { gb: 4, maxPlayers: 10, hoursAnHour: 1 },
          { gb: 8, maxPlayers: 50, hoursAnHour: 2 },
          { gb: 16, maxPlayers: 100, hoursAnHour: 4 },
        ],
        mods: true,
        datapacks: true,
        downloads: 'history',
        sessionsKept: 14,
        restsAfterDays: 30,
        deletedAfterDays: null,
      },
    ])
  })
})

// Player rows show the face on each player's skin, served by Blockly itself.
describe('player faces', () => {
  const account = '069a79f444e94726a5befca90e38aaf5'
  const face = new Uint8Array(8 * 8 * 4).fill(255)
  const faces = {
    face: async (uuid: string) =>
      uuid === account ? face : uuid === '069a79f444e94726a5befca90e38aaf6' ? 'unavailable' : null,
    named: async (name: string) => (name === 'Notch' ? face : null),
  } as unknown as PlayerFaces
  const app = createPublicApp({
    sharing: {} as SharingQueries,
    faces,
    items: {} as ItemIcons,
    icons: {} as ServerIcons,
    platform: () => ({ unsoldPlans: [] }),
  })

  test('an 8×8 picture, cached for the hour Blockly keeps it', async () => {
    const response = await app.request(`/api/public/players/${account}/face.png`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
    const png = new Uint8Array(await response.arrayBuffer())
    // The PNG signature, then the header chunk's width and height.
    expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47])
    expect(new DataView(png.buffer).getUint32(16)).toBe(8)
    expect(new DataView(png.buffer).getUint32(20)).toBe(8)
  })

  test('none for a player without a skin; the page draws its own', async () => {
    const response = await app.request('/api/public/players/2289dfb4-69e8-34dd-94a2-8862994e2feb/face.png')
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
  })

  test('by name, for a server that doesn’t verify accounts', async () => {
    const found = await app.request('/api/public/names/Notch/face.png')
    expect(found.status).toBe(200)
    expect(found.headers.get('content-type')).toBe('image/png')
    expect((await app.request('/api/public/names/NoAccountHere/face.png')).status).toBe(404)
  })

  test('unavailable for now is never cached', async () => {
    const response = await app.request('/api/public/players/069a79f444e94726a5befca90e38aaf6/face.png')
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
