import { describe, expect, test } from 'bun:test'
import { javaProperties, maxMemory, neoForgeGame, startInfo } from './server-pack.ts'

const info = (names: string[], texts: Record<string, string> = {}, serverStarter?: unknown) =>
  startInfo({ names, texts, ...(serverStarter === undefined ? {} : { serverStarter }) })

describe('how a server pack starts, read and never run', () => {
  test('ServerPackCreator’s variables.txt says it all', () => {
    const read = info(['variables.txt', 'start.sh', 'mods/a.jar'], {
      'variables.txt': [
        '# ServerPackCreator',
        'MINECRAFT_VERSION=1.20.1',
        'MODLOADER=Forge',
        'MODLOADER_VERSION=47.2.0',
        'JAVA_ARGS="-Xms4G -Xmx6G -Dfml.queryResult=confirm"',
      ].join('\n'),
    })
    expect(read).toMatchObject({
      loader: 'forge',
      loaderVersion: '47.2.0',
      gameVersion: '1.20.1',
      memoryMb: 6144,
      javaProperties: { 'fml.queryResult': 'confirm' },
    })
  })

  test('All the Mods 10’s start script names NeoForge, and the release follows from its number', () => {
    const script = [
      '#!/bin/bash',
      'NEOFORGE_VERSION=21.1.251',
      'INSTALLER="neoforge-$NEOFORGE_VERSION-installer.jar"',
      'java @user_jvm_args.txt @libraries/net/neoforged/neoforge/$NEOFORGE_VERSION/unix_args.txt nogui',
    ].join('\n')
    const read = info(['startserver.sh', 'user_jvm_args.txt', 'neoforge-21.1.251-installer.jar'], {
      'startserver.sh': script,
      'user_jvm_args.txt': '-Xms4G\n-Xmx8G\n',
    })
    expect(read).toMatchObject({
      loader: 'neoforge',
      loaderVersion: '21.1.251',
      gameVersion: '1.21.1',
      memoryMb: 8192,
    })
  })

  test('Forge’s own run.sh names the release and the build in its arguments file', () => {
    const read = info(['run.sh'], {
      'run.sh':
        'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.4.0/unix_args.txt "$@"',
    })
    expect(read).toMatchObject({ loader: 'forge', gameVersion: '1.20.1', loaderVersion: '47.4.0' })
  })

  test('an installed pack is read from the libraries it carries', () => {
    expect(info(['libraries/net/minecraftforge/forge/1.16.5-36.2.39/forge.jar'])).toMatchObject({
      loader: 'forge',
      gameVersion: '1.16.5',
      loaderVersion: '36.2.39',
    })
    expect(
      info([
        'libraries/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar',
        'libraries/net/minecraft/server/1.20.1/server-1.20.1.jar',
      ]),
    ).toMatchObject({
      loader: 'fabric',
      loaderVersion: '0.16.9',
    })
    expect(info(['forge-1.12.2-14.23.5.2860.jar', 'minecraft_server.1.12.2.jar'])).toMatchObject({
      loader: 'forge',
      gameVersion: '1.12.2',
      loaderVersion: '14.23.5.2860',
    })
    expect(info(['fabric-server-mc.1.20.1-loader.0.14.21-launcher.1.0.0.jar'])).toMatchObject({
      loader: 'fabric',
      gameVersion: '1.20.1',
      loaderVersion: '0.14.21',
    })
  })

  test('a ServerStarter pack that downloads its own mods says so', () => {
    const read = info(
      ['server-setup-config.yaml', 'serverstarter-2.4.0.jar'],
      {},
      {
        install: {
          mcVersion: '1.16.5',
          loaderVersion: '36.1.0',
          modpackUrl: 'https://example.test/pack.zip',
          modpackFormat: 'curse',
        },
        launch: { maxRam: '5G' },
      },
    )
    expect(read).toMatchObject({
      loader: 'forge',
      gameVersion: '1.16.5',
      loaderVersion: '36.1.0',
      memoryMb: 5120,
      downloadsOwnMods: true,
    })
  })

  test('a value built from other variables isn’t a version anyone wrote down', () => {
    expect(
      info(['start.sh'], { 'start.sh': 'FORGE_VERSION=$1\nMC_VERSION=%VERSION%' }).loaderVersion,
    ).toBeNull()
  })
})

describe('memory and properties from JVM arguments', () => {
  test('the largest -Xmx, in megabytes, and nothing from a comment', () => {
    expect(maxMemory('-Xms2G -Xmx6G')).toBe(6144)
    expect(maxMemory('# -Xmx32G\n-Xmx4096M')).toBe(4096)
    expect(maxMemory('nothing here')).toBeNull()
  })

  test('only plain -D properties, never ones that change how Java itself runs', () => {
    expect(
      javaProperties(
        '-Dfml.queryResult=confirm -Dlog4j2.formatMsgNoLookups=true -Djava.security.manager=allow -Dfml.readTimeout=180',
      ),
    ).toEqual({ 'fml.queryResult': 'confirm', 'fml.readTimeout': '180' })
    expect(javaProperties('-javaagent:evil.jar -XX:OnOutOfMemoryError=sh')).toEqual({})
  })
})

describe('the Minecraft a NeoForge build is for', () => {
  test('by how NeoForge numbers them', () => {
    expect(neoForgeGame('21.1.251')).toBe('1.21.1')
    expect(neoForgeGame('21.0.167')).toBe('1.21')
    expect(neoForgeGame('20.4.237')).toBe('1.20.4')
    expect(neoForgeGame('26.1.2.109')).toBe('26.1.2')
    expect(neoForgeGame('26.2.0.88')).toBe('26.2')
    expect(neoForgeGame('47.1.99')).toBeNull()
  })
})
