// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which of the account's servers the navigation lists, which row is unfolded and what a press on
 * one does, how many rows show, and the pages under the open one (./server-nav.ts).
 */
import { describe, expect, test } from 'bun:test'
import {
  type ListedServer,
  listedServers,
  MOST_ROWS,
  NOTHING_PRESSED,
  openServer,
  pressRow,
  rowsShown,
  serverPages,
  sidebarRows,
  unfolded,
} from './server-nav'

const server = (id: string, name: string): ListedServer => ({ id, name, icon: null, ownIcon: null })
const newest = server('newest', 'Arcade')
const older = server('older', 'Maple Hollow')
const owned = [newest, older]

describe("the server the phone's bar shows", () => {
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

  test("take the name and picture the server's own page read", () => {
    const renamed: ListedServer = { ...older, name: 'Maple Glen', icon: 'torch' }
    expect(listedServers(owned, renamed)[1]).toEqual(renamed)
  })

  test("put a server that isn't the account's own first, as an admin looking at another's", () => {
    const theirs = server('theirs', 'Duels')
    expect(listedServers(owned, theirs).map((s) => s.id)).toEqual(['theirs', 'newest', 'older'])
  })

  test('are only what the list holds away from a server', () => {
    expect(listedServers(owned, undefined)).toEqual(owned)
  })
})

describe('the rows shown', () => {
  const many = Array.from({ length: 20 }, (_, i) => server(`s${i}`, `Server ${i}`))
  const ids = (shown: { rows: ListedServer[] }) => shown.rows.map((s) => s.id)

  test('are every server, up to the most any plan includes', () => {
    const three = many.slice(0, 3)
    expect(MOST_ROWS).toBe(3)
    expect(rowsShown(three, undefined)).toEqual({ rows: three, more: 0 })
  })

  test('past that, are one fewer, newest first, and count the rest', () => {
    expect(rowsShown(many, undefined)).toEqual({ rows: [many[0], many[1]] as ListedServer[], more: 18 })
  })

  test('take as much room for four servers as for four hundred', () => {
    const lines = (n: number) => {
      const shown = rowsShown(many.slice(0, n), undefined)
      return shown.rows.length + (shown.more > 0 ? 1 : 0)
    }
    expect(lines(4)).toBe(MOST_ROWS)
    expect(lines(20)).toBe(MOST_ROWS)
  })

  test("keep the page's own server in place of the last when it falls past them", () => {
    expect(ids(rowsShown(many, 's17'))).toEqual(['s0', 's17'])
  })

  test("leave the page's own server where it is when it is already among them", () => {
    expect(ids(rowsShown(many, 's0'))).toEqual(['s0', 's1'])
  })

  test("keep the page's own server's row when it is folded", () => {
    const folded = pressRow('s17', NOTHING_PRESSED, 's17')
    const shown = sidebarRows(many, 's17', folded)
    expect(shown.open).toBeUndefined()
    expect(ids(shown)).toEqual(['s0', 's17'])
  })

  test("keep the page's own server's row while another server is unfolded", () => {
    const other = pressRow('s17', NOTHING_PRESSED, 's0')
    const shown = sidebarRows(many, 's17', other)
    expect(shown.open).toBe('s0')
    expect(ids(shown)).toEqual(['s0', 's17'])
  })
})

describe('the unfolded row', () => {
  test('is the server whose page this is, before anything is pressed', () => {
    expect(unfolded('older', NOTHING_PRESSED)).toBe('older')
  })

  test('is none away from a server, before anything is pressed', () => {
    expect(unfolded(undefined, NOTHING_PRESSED)).toBeUndefined()
  })

  test('is the row pressed on a page of no server', () => {
    expect(unfolded(undefined, pressRow(undefined, NOTHING_PRESSED, 'older'))).toBe('older')
  })

  test('folds again when the same row is pressed again', () => {
    const opened = pressRow(undefined, NOTHING_PRESSED, 'older')
    expect(unfolded(undefined, pressRow(undefined, opened, 'older'))).toBeUndefined()
  })

  test("folds the page's own server when its row is pressed", () => {
    expect(unfolded('older', pressRow('older', NOTHING_PRESSED, 'older'))).toBeUndefined()
  })

  test("is another server pressed on a server's page, which folds the page's own", () => {
    expect(unfolded('older', pressRow('older', NOTHING_PRESSED, 'newest'))).toBe('newest')
  })

  test("is the page's own server again once the other is pressed shut", () => {
    const other = pressRow('older', NOTHING_PRESSED, 'newest')
    expect(unfolded('older', pressRow('older', other, 'newest'))).toBe('older')
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
