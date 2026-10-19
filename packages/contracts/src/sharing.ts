// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod'
import type { ReactionsView } from './guestbook.ts'
import type { JoinRange } from './joins.ts'
import {
  ADDRESS_MAX_LENGTH,
  ADDRESS_MIN_LENGTH,
  PLAYER_NAME_MAX_LENGTH,
  PLAYER_NAME_MIN_LENGTH,
} from './limits.ts'
import { InviteCode, type Loader, type PackView, type ServerIcon, ServerId } from './server.ts'
import type { TemplateCredits } from './templates.ts'

/**
 * Sharing a server (§15.6). One model behind all of it: a public page at `/server/<slug>`, an
 * invitation at `/join/<code>`, and the Share sheet the owner opens. A page and an invitation are
 * the same page; the invitation is the one that may put its holder on the whitelist.
 */

export const PageRef = z.object({
  slug: z.string().trim().toLowerCase().min(ADDRESS_MIN_LENGTH).max(ADDRESS_MAX_LENGTH),
})
export const InviteRef = z.object({ code: InviteCode })
export const SetPublicInput = z.object({ serverId: ServerId, public: z.boolean() })

/** Whether the owner lets others make a server like this one. */
export const SetCopyableInput = z.object({ serverId: ServerId, copyable: z.boolean() })

/** An invitee puts themselves on the whitelist: their Minecraft name, nothing else. */
export const JoinThroughInviteInput = z.object({
  code: InviteCode,
  playerName: z.string().trim().min(PLAYER_NAME_MIN_LENGTH).max(PLAYER_NAME_MAX_LENGTH),
})

/** What someone needs in their own game before they can join. */
export interface JoinNeeds {
  /** The release the server runs. */
  gameVersion: string
  /** Which players' games join it, by the plugins the server carries. */
  joins: JoinRange
  /**
   * The modpack the server plays, which is the one thing to install: it brings the loader and
   * every mod with it. When there is one, the loader and mods below are left empty. A pack the
   * server runs on its own isn't here: plain Minecraft joins it.
   */
  modpack: PackView | null
  /** The loader players install too; null when plain Minecraft is enough. */
  loader: { label: string; version: string | null } | null
  /** Mods players need in their own game, with where to get each. */
  mods: Array<{ name: string; url: string | null }>
}

/** A server as the people it is shared with see it. Nothing here is about machines. */
export interface PublicServerView {
  slug: string
  name: string
  description: string
  /** Who made the published maps its world is built on, from the template that world came from; null for none. */
  credits: TemplateCredits | null
  icon: ServerIcon | null
  /** Where its owner's own picture is fetched; it shows instead of `icon` when there is one. */
  ownIcon: string | null
  tags: string[]
  joinAddress: string
  /** Awake now, or asleep until someone joins. */
  awake: boolean
  /**
   * Asleep long enough that its world rests in storage: joining still wakes it, and bringing the
   * world back first makes that take a minute or two.
   */
  wakesSlowly: boolean
  online: number
  maxPlayers: number
  /**
   * Who is on right now, as the server itself reports them. Empty where the server doesn't check
   * accounts: a name there is whatever somebody typed, and the page doesn't vouch for it.
   */
  players: string[]
  /**
   * Whether the server checks players with Minecraft's account servers. Where it doesn't, the name
   * someone gives is exactly who they are to it, capitals included.
   */
  checksAccounts: boolean
  gameVersion: string
  loader: Loader
  needs: JoinNeeds
  /** Mods Blockly can name to a stranger: vanilla, or ones it vouches for. */
  mods: string[]
  /** Only people the owner adds can join. */
  whitelistOnly: boolean
  /** Opened through an invite link, which may put its holder on the whitelist. */
  invited: boolean
  /** Anyone can find it in the directory, not only through a link. */
  public: boolean
  /** The owner looking at their own page before anyone else can. */
  preview: boolean
  /** Cubepals runs it itself: an admin's mark, which can't be bought or claimed. */
  official: boolean
  /**
   * Whether a visitor can make a server set up like this one: it has booted at least once, Blockly
   * vouches for everything it runs, the way the directory judges it, and its owner offers copies.
   */
  copyable: boolean
  /** The person reading owns it: the page doesn't offer them a copy of their own server. */
  yours: boolean
  /**
   * Whether friends may chip in hours of play to it (`ChipInInput`): its owner lets them, and its
   * plan takes them. `hoursPerDollar` is real hours of play on it, as big as it is; null when not.
   */
  chipIn: { hoursPerDollar: number } | null
  /**
   * Its stars and notes, on its public page only: null on an invitation, on the owner's preview,
   * and wherever strangers can't see the page.
   */
  reactions: ReactionsView | null
}

/** Where an invitee stands after asking to be let in. */
export interface JoinThroughInviteResult {
  /** The name as Minecraft knows it. */
  playerName: string
  /** Already on the list, or added just now. */
  added: boolean
  /** The server is asleep; joining wakes it. */
  asleep: boolean
}

/** Everything behind one Share action. */
export interface ShareView {
  joinAddress: string
  inviteUrl: string
  pageUrl: string
  /** The page is open to anyone, and the directory may show it. */
  public: boolean
  /** In the directory right now. */
  listed: boolean
  /** Why the directory doesn't show it, in the owner's terms. */
  reasons: Array<{ code: string; detail?: string }>
  /** Blockly paused the directory for everyone. */
  directoryPaused: boolean
  moderation: 'clear' | 'removed'
  moderationNote: string | null
  /** Only people the owner adds can join, so an invite offers to add them. */
  whitelistOnly: boolean
  /**
   * Whether others may make a server like this one. `locked` when something it runs keeps copying
   * off whatever the owner wants, and `why` says what, in the owner's terms.
   */
  copying: { on: boolean; locked: boolean; why: string | null }
}
