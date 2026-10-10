// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a world download leaves out and keeps, pinned path by path for each kind of server, and
 * the note that names the mods it left out.
 */
import { describe, expect, test } from 'bun:test'
import { downloadNote, inWorldDownload, jarsInNote, LEFT_OUT_OF_DOWNLOADS } from './world-download.ts'

// What a server's disk holds under each loader, as the itzg image installs it (fake-minecraft/
// image.ts mirrors it) and as each loader's installer lays it out.
describe('a world download', () => {
  test('leaves out exactly these paths', () => {
    expect(LEFT_OUT_OF_DOWNLOADS.map((rule) => rule.path.source)).toEqual([
      '\\.jar$',
      '^libraries(\\/|$)',
      '^versions(\\/|$)',
      '^cache(\\/|$)',
      '^\\.[^/]',
      '^cubepals-download\\.txt$',
    ])
  })

  const leftOut = {
    vanilla: [
      'minecraft_server.26.3.jar',
      '.vanilla-manifest.json',
      'libraries/com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar',
      'versions/26.3/server-26.3.jar',
    ],
    paper: [
      'paper-26.3-12.jar',
      '.paper.env',
      'cache/mojang_26.3.jar',
      'libraries/io/papermc/paper/paper-api/26.3/paper-api-26.3.jar',
      'versions/26.3/paper-26.3.jar',
      'plugins/EssentialsX-2.21.jar',
      'plugins/.paper-remapped/EssentialsX-2.21.jar',
    ],
    fabric: [
      'fabric-server-mc.26.3-loader.0.17.2-launcher.1.1.0.jar',
      '.fabric/server/26.3-server.jar',
      '.fabric/remappedJars/minecraft-26.3/client-intermediary.jar',
      'libraries/net/fabricmc/fabric-loader/0.17.2/fabric-loader-0.17.2.jar',
      'mods/sodium-fabric-0.6.jar',
    ],
    forge: [
      'forge-1.20.1-47.3.0-shim.jar',
      'minecraft_server.1.20.1.jar',
      '.forge-manifest.json',
      'libraries/net/minecraftforge/forge/1.20.1-47.3.0/forge-1.20.1-47.3.0-server.jar',
      'libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt',
      'mods/create-1.20.1-0.5.1.jar',
    ],
    neoforge: [
      'libraries/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-server.jar',
      'libraries/net/neoforged/neoforge/21.1.77/unix_args.txt',
      'mods/jei-21.1.jar',
    ],
    quilt: [
      'quilt-server-launch.jar',
      'server.jar',
      '.quilt/server/26.3.jar',
      'libraries/org/quiltmc/quilt-loader/0.29.0/quilt-loader-0.29.0.jar',
    ],
    modpack: ['.modrinth-modpack-manifest.json', 'mods/create.jar', 'kubejs/mods/nested.jar'],
    note: ['cubepals-download.txt'],
  }
  for (const [kind, paths] of Object.entries(leftOut))
    test(`leaves out what ${kind} installed`, () => {
      expect(paths.filter(inWorldDownload)).toEqual([])
    })

  test('holds each world with its datapacks, the settings and configs, and the lists', () => {
    const held = [
      '',
      'server.properties',
      'eula.txt',
      'whitelist.json',
      'ops.json',
      'banned-players.json',
      'banned-ips.json',
      'usercache.json',
      'server-icon.png',
      'world/level.dat',
      'world/region/r.0.0.mca',
      'world/DIM-1/region/r.0.0.mca',
      'world_nether/DIM-1/region/r.0.0.mca',
      'world_the_end/DIM1/region/r.0.0.mca',
      'world/datapacks/castle-loot.zip',
      'world/datapacks/towers/pack.mcmeta',
      'world/datapacks/towers/data/towers/structure/tower.nbt',
      'survival/level.dat',
      'config/sodium-options.json',
      'config/create-common.toml',
      'defaultconfigs/ftbchunks.snbt',
      'kubejs/server_scripts/recipes.js',
      'plugins/Essentials/config.yml',
      'plugins/LuckPerms/luckperms-h2.mv.db',
      'mods/',
      'mods/.installed.json',
      'resources.zip',
      'user_jvm_args.txt',
    ]
    expect(held.filter((path) => !inWorldDownload(path))).toEqual([])
  })

  test('its note names the mods and plugins it left out, and an upload reads them back', () => {
    const note = downloadNote(['mods/create.jar', 'plugins/EssentialsX-2.21.jar'])
    expect(jarsInNote(note)).toEqual(['mods/create.jar', 'plugins/EssentialsX-2.21.jar'])
    // A vanilla world's note names none.
    expect(jarsInNote(downloadNote([]))).toEqual([])
    expect(downloadNote([])).not.toContain('Played with')
  })
})
