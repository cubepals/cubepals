// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minecraft as the application reaches it: a running server's console, whether it is ready, the
 * profiles and skins Mojang keeps for accounts, and the art a release's client jar holds for items.
 */
import type { SkinPixels } from '../../minecraft/skin.ts'
import type { Endpoint } from './runtime.ts'

export type { SkinPixels }

/** Where and how to reach a server's console. */
export interface ConsoleTarget {
  endpoint: Endpoint
  /** Tried in order until one is accepted: during a key rotation a server may have either. */
  passwords: readonly string[]
}

export class ConsoleUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConsoleUnavailable'
  }
}

/** Runs console commands on a live server. RCON today; the port does not say so. */
export interface ServerConsole {
  run(target: ConsoleTarget, command: string): Promise<string>
  /** Runs several commands over one connection, in order, collecting per-command failures. */
  runAll(
    target: ConsoleTarget,
    commands: readonly string[],
  ): Promise<Array<{ ok: true; output: string } | { ok: false; error: string }>>
}

export interface ServerStatusPing {
  online: number
  max: number
  version: string
}

/** "Ready" is a Minecraft protocol fact: the server answers a status ping. */
export interface ReadinessProbe {
  ping(endpoint: Endpoint, signal: AbortSignal): Promise<ServerStatusPing>
}

/** Mojang profile lookups. */
export interface PlayerProfiles {
  byName(name: string): Promise<{ uuid: string; name: string } | null>
  byUuid(uuid: string): Promise<{ uuid: string; name: string } | null>
  /**
   * The skin an account wears, decoded; null where it wears one of the game's defaults, or no
   * account has the UUID.
   */
  skinOf(uuid: string): Promise<SkinPixels | null>
}

/**
 * A release's own item art: the item definitions, models and item and block textures from its
 * client jar, which Blockly fetches from Mojang and checks, and never ships (§ item icons).
 */
export interface ClientAssets {
  /** The release's files under `assets/minecraft/`; the first ask for a release fetches its jar. */
  open(gameVersion: string): Promise<ClientFiles>
}

export interface ClientFiles {
  /** A file's bytes by its path under `assets/minecraft/`; null where the jar had no such file. */
  read(path: string): Uint8Array | null
}

/** The client jar Mojang served isn't the one its manifest describes, and nothing of it is used. */
export class ClientJarRejected extends Error {
  constructor(detail: string) {
    super(`The client jar was refused: ${detail}`)
    this.name = 'ClientJarRejected'
  }
}
