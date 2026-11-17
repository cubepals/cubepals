// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The account's servers in the app's navigation, on every page and not only on a server's own:
 * each server by name, and under the open one its pages, so a server's Players or Mods is one
 * press from the Account page or Browse rather than three.
 *
 * The open server is the one whose page this is. Away from a server, it is the one last opened in
 * this visit, else the newest: for an account with one server, that is always it.
 * Nothing is kept past the visit, so the first paint draws what the server drew.
 *
 * It decides what is listed and open; the frame (./frame.tsx) draws it, in the sidebar and in
 * the phone's bottom bar.
 */
import type { ServerView } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import { Archive, Globe, LayoutGrid, Puzzle, Settings, SquareTerminal, Users } from 'lucide-react'
import { useState } from 'react'
import { useTRPC } from '../../lib/api'
import type { NavEntry } from './more-menu'

/** A server as the navigation lists it. */
export type ListedServer = { id: string; name: string }

/**
 * Which server is open: the one whose page this is, else the last one opened while it is still
 * the account's, else the newest. The list comes newest first, as the control plane sends it.
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
  const listed = owned.map(({ id, name }) => ({ id, name }))
  if (here === undefined) return listed
  if (!listed.some((server) => server.id === here.id)) return [here, ...listed]
  return listed.map((server) => (server.id === here.id ? here : server))
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
 * The servers the navigation lists, which is open, and the open one's pages. `here` is the server
 * whose page this is, and `current` what its page read of it, fresher than the list.
 */
export function useServerNav(here: string | undefined, current: ServerView | undefined) {
  const trpc = useTRPC()
  // In the first paint (lib/first-paint.ts), so the list is drawn with the page.
  const owned = useQuery(trpc.servers.list.queryOptions()).data ?? []
  // Kept while the app stays open: the frame isn't drawn again as its pages change.
  const [last, setLast] = useState(here)
  if (here !== undefined && here !== last) setLast(here)
  const open = openServer(here, last, owned)
  const view = open === here && current !== undefined ? current : owned.find((s) => s.id === open)
  const servers = listedServers(
    owned,
    here === undefined ? undefined : { id: here, name: current?.name ?? listedName(owned, here) },
  )
  return { servers, open, pages: open === undefined ? [] : serverPages(open, view) }
}

/** A server's name from the list, before its own page has read it. */
const listedName = (owned: readonly ListedServer[], id: string) =>
  owned.find((server) => server.id === id)?.name ?? 'Your server'
