// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The account's servers in the app's navigation, on every page and not only on a server's own:
 * each server as one row, its picture and its name, whose pages unfold under it when it is open
 * (./server-rows.tsx). A server is open while this is one of its pages, or once someone presses
 * its row, until they go somewhere else; everywhere else the rows are closed, so a page like
 * Account stays as calm as it was. At most a few rows show, the last of them counting the rest, so
 * the navigation is the same height for an account with a few servers and one with hundreds.
 *
 * The phone's bottom bar has no rows to open: it shows the pages of the server whose page this
 * is, else of the one last opened in this visit, else of the newest.
 *
 * It decides what is listed and open; ./server-rows.tsx and the frame (./frame.tsx) draw it.
 */
import type { ServerView } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import { Archive, Globe, LayoutGrid, Puzzle, Settings, SquareTerminal, Users } from 'lucide-react'
import { useState } from 'react'
import { useTRPC } from '../../lib/api'
import type { NavEntry } from './more-menu'

/** A server as the navigation lists it: its name and its picture. */
export type ListedServer = Pick<ServerView, 'id' | 'name' | 'icon' | 'ownIcon'>

/**
 * The most server rows the sidebar shows: every server any plan includes, and few enough that one
 * server's pages still fit under them on a laptop's screen.
 */
export const MOST_ROWS = 3

/**
 * The server the phone's bar shows the pages of: the one whose page this is, else the last one
 * opened while it is still the account's, else the newest. The list comes newest first, as the
 * control plane sends it.
 */
export function openServer(
  here: string | undefined,
  last: string | undefined,
  owned: readonly ListedServer[],
): string | undefined {
  if (here !== undefined) return here
  if (last !== undefined && owned.some((server) => server.id === last)) return last
  return owned[0]?.id
}

/**
 * The servers listed, in the list's order, so opening one never moves the others. A server whose
 * page this is and that isn't the account's own, as an admin looking at another's, comes first.
 */
export function listedServers(
  owned: readonly ListedServer[],
  here: ListedServer | undefined,
): ListedServer[] {
  const listed = owned.map(({ id, name, icon, ownIcon }) => ({ id, name, icon, ownIcon }))
  if (here === undefined) return listed
  if (!listed.some((server) => server.id === here.id)) return [here, ...listed]
  return listed.map((server) => (server.id === here.id ? here : server))
}

/**
 * The rows the sidebar shows, and how many servers are left to the Servers page. Up to MOST_ROWS
 * servers, every one. Past that, one row fewer, in the list's order with the open one kept in
 * place of the last when it falls past them, and a last row for the rest: the sidebar is never
 * taller than with MOST_ROWS servers, however many an account has.
 */
export function rowsShown(
  servers: readonly ListedServer[],
  open: string | undefined,
): { rows: ListedServer[]; more: number } {
  if (servers.length <= MOST_ROWS) return { rows: [...servers], more: 0 }
  const rows = servers.slice(0, MOST_ROWS - 1)
  const kept = servers.find((server) => server.id === open)
  if (kept !== undefined && !rows.includes(kept)) rows[rows.length - 1] = kept
  return { rows, more: servers.length - rows.length }
}

/** What someone did to the rows on this page: opened one by hand, or closed the page's own. */
export type Unfolding = { opened: string | null; closedHere: boolean }

export const NOTHING_PRESSED: Unfolding = { opened: null, closedHere: false }

/** The open row: one opened by hand, else the server whose page this is unless it was closed. */
export function unfolded(here: string | undefined, pressed: Unfolding): string | undefined {
  if (pressed.opened !== null) return pressed.opened
  return pressed.closedHere ? undefined : here
}

/**
 * A press on a server's row: the open row closes, any other opens in its place, so one server's
 * pages show at a time.
 */
export function pressRow(here: string | undefined, pressed: Unfolding, serverId: string): Unfolding {
  if (unfolded(here, pressed) !== serverId) return { opened: serverId, closedHere: false }
  return { opened: null, closedHere: serverId === here }
}

/** A server's pages, in the order the navigation shows them. */
export function serverPages(
  serverId: string,
  view: Pick<ServerView, 'players' | 'loader'> | undefined,
): NavEntry[] {
  const base = `/servers/${serverId}`
  return [
    { href: base, label: 'Overview', icon: LayoutGrid },
    {
      href: `${base}/players`,
      label: 'Players',
      icon: Users,
      trailing: view?.players ? String(view.players.online) : undefined,
    },
    { href: `${base}/mods`, label: view?.loader === 'paper' ? 'Plugins' : 'Mods', icon: Puzzle },
    { href: `${base}/world`, label: 'World', icon: Globe },
    { href: `${base}/backups`, label: 'Backups', icon: Archive },
    { href: `${base}/console`, label: 'Console', icon: SquareTerminal },
    { href: `${base}/settings`, label: 'Settings', icon: Settings },
  ]
}

/**
 * The servers the navigation lists, the one the phone's bar shows, and any server's pages. `here`
 * is the server whose page this is, and `current` what its page read of it, fresher than the list.
 */
export function useServerNav(here: string | undefined, current: ServerView | undefined) {
  const trpc = useTRPC()
  // In the first paint (lib/first-paint.ts), so the navigation is drawn with the page.
  const owned = useQuery(trpc.servers.list.queryOptions()).data ?? []
  // Kept while the app stays open: the frame isn't drawn again as its pages change.
  const [last, setLast] = useState(here)
  if (here !== undefined && here !== last) setLast(here)
  const open = openServer(here, last, owned)
  const viewOf = (serverId: string) =>
    serverId === here && current !== undefined ? current : owned.find((s) => s.id === serverId)
  const servers = listedServers(owned, here === undefined ? undefined : hereListed(here, current, owned))
  const pagesOf = (serverId: string) => serverPages(serverId, viewOf(serverId))
  return { servers, open, pages: open === undefined ? [] : pagesOf(open), pagesOf }
}

/** The server whose page this is, as its page read it, else as the list has it. */
function hereListed(id: string, current: ServerView | undefined, owned: readonly ListedServer[]) {
  const listed = current ?? owned.find((server) => server.id === id)
  return {
    id,
    name: listed?.name ?? 'Your server',
    icon: listed?.icon ?? null,
    ownIcon: listed?.ownIcon ?? null,
  }
}
