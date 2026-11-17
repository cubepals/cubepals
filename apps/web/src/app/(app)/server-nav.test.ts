// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which of the account's servers the navigation lists and opens on every page, and the pages it
 * shows under the open one (./server-nav.ts).
 */
import { describe, expect, test } from 'bun:test'
import { listedServers, openServer, serverPages } from './server-nav'

const newest = { id: 'newest', name: 'Arcade' }
const older = { id: 'older', name: 'Maple Hollow' }
const owned = [newest, older]

describe('the open server', () => {
  test('is the one whose page this is, wherever it is in the list', () => {
    expect(openServer('older', 'newest', owned)).toBe('older')
  })

  test('away from a server, is the one last opened', () => {
    expect(openServer(undefined, 'older', owned)).toBe('older')
  })

  test('away from a server and with none opened yet, is the newest', () => {
    expect(openServer(undefined, undefined, owned)).toBe('newest')
  })

  test('is the newest once the last one opened is deleted', () => {
    expect(openServer(undefined, 'gone', owned)).toBe('newest')
  })

  test('is none for an account with no server', () => {
    expect(openServer(undefined, undefined, [])).toBeUndefined()
  })
})

describe('the servers listed', () => {
  test("keep the list's order whichever is open", () => {
    expect(listedServers(owned, older).map((s) => s.id)).toEqual(['newest', 'older'])
  })

  test("take the name the server's own page read", () => {
    expect(listedServers(owned, { id: 'older', name: 'Maple Glen' })[1]?.name).toBe('Maple Glen')
  })

  test("put a server that isn't the account's own first, as an admin looking at another's", () => {
    const theirs = { id: 'theirs', name: 'Duels' }
    expect(listedServers(owned, theirs).map((s) => s.id)).toEqual(['theirs', 'newest', 'older'])
  })

  test('are only what the list holds away from a server', () => {
    expect(listedServers(owned, undefined)).toEqual(owned)
  })
})

describe("a server's pages", () => {
  test('link under the server, Overview first', () => {
    expect(serverPages('older', undefined).map((page) => page.href)).toEqual([
      '/servers/older',
      '/servers/older/players',
      '/servers/older/mods',
      '/servers/older/world',
      '/servers/older/backups',
      '/servers/older/console',
      '/servers/older/settings',
    ])
  })

  test('say Plugins on Paper and count who is on', () => {
    const pages = serverPages('older', { loader: 'paper', players: { online: 2, people: [] } })
    expect(pages.map((page) => page.label)).toContain('Plugins')
    expect(pages.find((page) => page.label === 'Players')?.trailing).toBe('2')
  })
})
