import { describe, expect, test } from 'bun:test'
import type { PublicPlan } from '@blockly/contracts'
import type { PlayerFaces } from '../../app/access/faces.ts'
import type { ItemIcons } from '../../app/items/icons.ts'
import type { SharingQueries } from '../../app/sharing/queries.ts'
import { createPublicApp } from './public.ts'

// The pricing page reads the plans from here, signed in or not, so what it shows is the table
// that is enforced and never a copy of it.
describe('public sizes', () => {
  const app = createPublicApp({
    sharing: {} as SharingQueries,
    faces: {} as PlayerFaces,
    items: {} as ItemIcons,
  })

  test('each answer to who is playing, with the players it holds and its memory', async () => {
    const response = await app.request('/api/public/sizes')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await response.json()).toEqual([
      { party: '5', maxPlayers: 5, memory: '3 GB' },
      { party: '10', maxPlayers: 10, memory: '4 GB' },
      { party: '20', maxPlayers: 20, memory: '8 GB' },
      { party: 'more', maxPlayers: 40, memory: '8 GB' },
    ])
  })
})

describe('public plans', () => {
  const app = createPublicApp({
    sharing: {} as SharingQueries,
    faces: {} as PlayerFaces,
    items: {} as ItemIcons,
  })

  test('Free and Plus, with what each costs and includes', async () => {
    const response = await app.request('/api/public/plans')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    const plans = (await response.json()) as PublicPlan[]
    expect(plans).toEqual([
      {
        key: 'free',
        name: 'Free',
        monthlyPriceCents: 0,
        includedHours: 20,
        sleepsAfterMinutes: 10,
        maxServers: 1,
        maxPlayers: 5,
        mods: false,
        downloads: 'daily',
        restsAfterDays: 14,
        deletedAfterDays: 365,
      },
      {
        key: 'plus',
        name: 'Plus',
        monthlyPriceCents: 1500,
        includedHours: 60,
        sleepsAfterMinutes: 15,
        maxServers: 3,
        maxPlayers: 40,
        mods: true,
        downloads: 'history',
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
  const app = createPublicApp({ sharing: {} as SharingQueries, faces, items: {} as ItemIcons })

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
