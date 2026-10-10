// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { handDownloads, packEnvironment, packTier, runsAsCode, suggestedForServers } from './packs.ts'

/**
 * What Blockly can tell about a modpack before it has run one. The numbers behind these come
 * from `docs/minecraft-capacity-research.md`, where three packs were measured on real machines.
 */
describe('modpacks', () => {
  test('a pack starts on the size its own tags argue for, and only a kitchen sink starts large', () => {
    // Cobblemon calls itself lightweight, and measured 567 MB idle, 639 MB after a pregen —
    // a fraction of the smallest box's heap.
    expect(packTier(['adventure', 'lightweight', 'multiplayer'])).toBe('3g')
    // Better MC and Prominence II claim neither tag, and the middle is where every pack
    // measured actually sat.
    expect(packTier(['adventure', 'combat', 'optimization'])).toBe('4g')
    expect(packTier([])).toBe('4g')
    expect(packTier()).toBe('4g')
    // A kitchen sink wants the four cores that come with the large size; 6 GB isn't sold.
    expect(packTier(['kitchen-sink', 'lightweight'])).toBe('8g')
    // Nothing but a pack that says it is everything at once starts large.
    for (const tags of [[], ['lightweight'], ['technology', 'magic']]) expect(packTier(tags)).not.toBe('8g')
    for (const tags of [[], ['kitchen-sink'], ['lightweight']]) expect(packTier(tags)).not.toBe('6g')
  })

  test('a pack asks nothing of players only when it says it is made for servers', () => {
    // Cobblemon and Better MC: everyone playing installs them.
    expect(packEnvironment(['client_and_server'])).toBe('both')
    // A pack that says either side can run it can still carry blocks a plain game can't show,
    // so players are asked to install it: a friend turned away at the door is the worse mistake.
    expect(packEnvironment(['client_or_server_prefers_both'])).toBe('both')
    expect(packEnvironment(['client_or_server'])).toBe('both')
    expect(packEnvironment(['client_only_server_optional'])).toBe('both')
    // Made for servers: plain Minecraft joins.
    expect(packEnvironment(['server_only'])).toBe('server')
    expect(packEnvironment(['dedicated_server_only', 'server_only_client_optional'])).toBe('server')
    // Sodium Plus: a pack for players' games with one server version, which asks nothing of them.
    expect(packEnvironment(['client_only', 'dedicated_server_only'])).toBe('server')
    // Fabulously Optimized: no server at all.
    expect(packEnvironment(['client_only'])).toBe('client')
    expect(packEnvironment(['client_only', 'singleplayer_only'])).toBe('client')
    // A catalogue that says nothing is the common case.
    expect(packEnvironment([])).toBe('both')
    expect(packEnvironment()).toBe('both')
  })

  test('the packs suggested for a server are the ones played together, or made for servers', () => {
    // Cobblemon and Better MC: everyone playing installs them.
    expect(suggestedForServers(['client_and_server'])).toBe(true)
    expect(suggestedForServers(['client_or_server_prefers_both'])).toBe(true)
    expect(suggestedForServers(['client_only', 'client_and_server'])).toBe(true)
    // A pack made for servers alone.
    expect(suggestedForServers(['server_only'])).toBe(true)
    // Fabulously Optimized and Remarkably Optimized, as the catalogue marks them: no server.
    expect(suggestedForServers(['client_only'])).toBe(false)
    expect(suggestedForServers(['singleplayer_only'])).toBe(false)
    // Sodium Plus: a pack for players' games with one server version. It can be found and run,
    // but its downloads are players', so it isn't what "most people are playing" on a server.
    expect(suggestedForServers(['client_only', 'dedicated_server_only'])).toBe(false)
    // Nothing said is not a reason to leave it out.
    expect(suggestedForServers([])).toBe(true)
    expect(suggestedForServers()).toBe(true)
  })

  test('the mods a pack leaves for players to download by hand are named from its list', () => {
    // Better MC's Modrinth edition's list, as it shipped on 2026-09-24 (two of its 34).
    expect(
      handDownloads([
        {
          displayName: 'Balm (Fabric Edition)',
          pattern: 'balm-fabric-1.20.1-7.3.38.jar',
          destination: 'mods',
        },
        { displayName: 'FTB Teams (Fabric)', pattern: 'ftb-teams-fabric-2001.3.2.jar', destination: 'mods' },
      ]),
    ).toEqual(['Balm (Fabric Edition)', 'FTB Teams (Fabric)'])
    // Anything else says nothing, rather than turning a pack away.
    expect(handDownloads({ mods: [] })).toEqual([])
    expect(handDownloads([{ pattern: 'x.jar' }])).toEqual([])
  })

  test('what runs as code besides a pack’s mods is named for a reviewer, never refused for it', () => {
    expect(runsAsCode('overrides/kubejs/server_scripts/recipes.js')).toBe(true)
    expect(runsAsCode('overrides/scripts/tweaks.zs')).toBe(true)
    expect(runsAsCode('overrides/libraries/extra.jar')).toBe(true)
    expect(runsAsCode('overrides/start.sh')).toBe(true)
    // Its mods are what a pack is; they are reviewed as works, by licence.
    expect(runsAsCode('overrides/mods/carried.jar')).toBe(false)
    expect(runsAsCode('overrides/config/lithium.properties')).toBe(false)
  })
})
