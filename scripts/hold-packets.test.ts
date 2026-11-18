// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The hold's packet ids: taken from each release's own report, and checked against Mojang's manifest. */
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import releases from '../apps/control/src/minecraft/protocol-versions.json' with { type: 'json' }
import { packetsFor } from '../apps/edge/hold-packet-ids.ts'
import held from '../apps/edge/hold-packets.json' with { type: 'json' }
import { PACKETS } from './hold-layouts.ts'
import { FIRST_DIALOG, idsOf, main, releasesToReport, type World } from './hold-packets.ts'

/** A report as `server.jar --reports` writes `packets.json`, holding just these packets. */
const report = (
  configuration: Record<string, number>,
  serverbound: Record<string, number> = { keep_alive: 4 },
) => ({
  login: {
    clientbound: { 'minecraft:login_finished': { protocol_id: 2 }, 'minecraft:hello': { protocol_id: 1 } },
    serverbound: { 'minecraft:login_acknowledged': { protocol_id: 3 } },
  },
  configuration: {
    clientbound: Object.fromEntries(
      Object.entries(configuration).map(([k, v]) => [`minecraft:${k}`, { protocol_id: v }]),
    ),
    serverbound: Object.fromEntries(
      Object.entries(serverbound).map(([k, v]) => [`minecraft:${k}`, { protocol_id: v }]),
    ),
  },
})

test('the ids come from the report, by the names the game gives them', () => {
  expect(
    idsOf(report({ disconnect: 2, keep_alive: 4, show_dialog: 19, transfer: 12 }, { keep_alive: 5 })),
  ).toEqual({
    login: { finished: 2, acknowledged: 3 },
    configuration: { disconnect: 2, keepAlive: 4, showDialog: 19, transfer: 12, keepAliveAnswer: 5 },
  })
})

test('a report missing any of them is refused, naming it', () => {
  expect(() => idsOf(report({ disconnect: 2, keep_alive: 4, transfer: 12 }))).toThrow(
    'the report has no configuration clientbound minecraft:show_dialog',
  )
  expect(() => idsOf(report({ disconnect: 2, keep_alive: 4, show_dialog: 19, transfer: 12 }, {}))).toThrow(
    'configuration serverbound minecraft:keep_alive',
  )
  expect(() => idsOf({})).toThrow('the report has no login clientbound minecraft:login_finished')
})

test('each protocol from 1.21.6 on is reported once, from its newest release', () => {
  expect(
    releasesToReport([
      { name: '26.1.2', protocol: 775 },
      { name: '26.1.1', protocol: 775 },
      { name: '1.21.7', protocol: 772 },
      { name: '1.21.6', protocol: FIRST_DIALOG },
      { name: '1.21.5', protocol: FIRST_DIALOG - 1 },
    ]),
  ).toEqual([
    { protocol: 775, release: '26.1.2' },
    { protocol: 772, release: '1.21.7' },
    { protocol: 771, release: '1.21.6' },
  ])
})

test('the copy covers every protocol the edge knows from 1.21.6 on, from that protocol’s newest release', () => {
  expect(held.protocols.map(({ protocol, release }) => ({ protocol, release }))).toEqual(
    releasesToReport(releases.releases),
  )
  for (const entry of held.protocols) expect(entry.jar).toMatch(/^[0-9a-f]{40}$/)
})

// ─── bump and check, against a manifest and a Java of the test's own ───────────────────────

const JAR = new TextEncoder().encode('a server jar')
const SHA1 = createHash('sha1').update(JAR).digest('hex')
const REPORT = report({ disconnect: 2, keep_alive: 4, show_dialog: 18, transfer: 11 })

/** How `javap` prints the two packets' classes, cut to what their layout is read from. */
const LISTINGS = {
  [PACKETS.loginFinished]: `  static {};
       0: getstatic     #45                 // Field net/minecraft/network/codec/ByteBufCodecs.GAME_PROFILE:Lnet/minecraft/network/codec/StreamCodec;
       8: getstatic     #55                 // Field net/minecraft/core/UUIDUtil.STREAM_CODEC:Lnet/minecraft/network/codec/StreamCodec;
`,
  [PACKETS.transfer]: `  private void write(net.minecraft.network.FriendlyByteBuf);
       5: invokevirtual #30                 // Method net/minecraft/network/FriendlyByteBuf.writeUtf:(Ljava/lang/String;)Lnet/minecraft/network/FriendlyByteBuf;
      14: invokevirtual #34                 // Method net/minecraft/network/FriendlyByteBuf.writeVarInt:(I)Lnet/minecraft/network/FriendlyByteBuf;
`,
}

function worldOf(options: { jar?: Uint8Array; exit?: number; status?: number; transfer?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hold-packets-test-'))
  const java = join(dir, 'java')
  // Writes the report where the server would, in the directory it is run from, and unpacks the
  // game's jar beside it as the bundler does; or fails.
  writeFileSync(
    java,
    `#!/bin/sh\nmkdir -p out/reports versions/1 && printf '%s' '${JSON.stringify(REPORT)}' > out/reports/packets.json && : > versions/1/server-1.jar\nexit ${options.exit ?? 0}\n`,
  )
  chmodSync(java, 0o755)
  // Prints the listing of the class it is asked for, from beside it, and fails for any other.
  const listings = {
    ...LISTINGS,
    ...(options.transfer === undefined ? {} : { [PACKETS.transfer]: options.transfer }),
  }
  for (const [name, text] of Object.entries(listings)) writeFileSync(join(dir, `${name}.javap`), text)
  const javap = join(dir, 'javap')
  writeFileSync(javap, `#!/bin/sh\nfor last; do :; done\nexec cat "${dir}/$last.javap"\n`)
  chmodSync(javap, 0o755)
  const releasesPath = join(dir, 'releases.json')
  writeFileSync(
    releasesPath,
    JSON.stringify({
      releases: [
        { name: '1.21.7', protocol: 772 },
        { name: '1.21.6', protocol: 771 },
        { name: '1.21.5', protocol: 770 },
      ],
    }),
  )
  const fetched: string[] = []
  const said: string[] = []
  const world: World = {
    fetch: async (url: string) => {
      fetched.push(url)
      if (url.endsWith('version_manifest_v2.json'))
        return Response.json({
          versions: [
            { id: '1.21.7', url: 'https://meta.test/1.21.7.json' },
            { id: '1.21.6', url: 'https://meta.test/1.21.6.json' },
          ],
        })
      if (url.startsWith('https://meta.test/'))
        return Response.json({
          downloads: { server: { sha1: SHA1, url: `https://jars.test/${url.slice(18)}` } },
        })
      if (url.startsWith('https://jars.test/')) return new Response(options.jar ?? JAR)
      return new Response(null, { status: 404 })
    },
    java,
    javap,
    copy: join(dir, 'hold-packets.json'),
    releases: releasesPath,
    say: (line) => said.push(line),
  }
  if (options.status !== undefined) {
    const real = world.fetch
    world.fetch = async (url) =>
      url.endsWith('version_manifest_v2.json') ? new Response(null, { status: options.status }) : real(url)
  }
  return { world, fetched, said, dir }
}

test('bump runs each release’s own jar and writes its ids; check then finds nothing wrong', async () => {
  const { world, said } = worldOf()
  expect(await main(['bump'], world)).toBe(0)
  const written = JSON.parse(readFileSync(world.copy, 'utf8'))
  expect(written).toEqual({
    source: 'server.jar --reports',
    protocols: [772, 771].map((protocol) => ({
      protocol,
      release: protocol === 772 ? '1.21.7' : '1.21.6',
      jar: SHA1,
      login: { finished: 2, acknowledged: 3 },
      configuration: { disconnect: 2, keepAlive: 4, showDialog: 18, transfer: 11, keepAliveAnswer: 4 },
      layouts: { loginFinished: 'profile+session', transfer: 'host+port' },
    })),
  })
  expect(said).toEqual(['1.21.7 (772): reported', '1.21.6 (771): reported'])
  expect(await main(['check'], world)).toBe(0)
  expect(said.at(-1)).toBe(`${world.copy} is each release's own report`)
})

test('check names a protocol with no entry, and one reported from another jar', async () => {
  const { world, said } = worldOf()
  await main(['bump'], world)
  const written = JSON.parse(readFileSync(world.copy, 'utf8'))
  written.protocols = [{ ...written.protocols[0], jar: '0'.repeat(40) }]
  writeFileSync(world.copy, JSON.stringify(written))
  expect(await main(['check'], world)).toBe(1)
  expect(said.at(-1)).toBe(
    `${world.copy}: 1.21.7 (772) wasn't reported from its own jar; 1.21.6 (771) has no entry: run bump`,
  )
  written.protocols = [{ ...written.protocols[0], jar: SHA1, release: '1.21.8' }]
  writeFileSync(world.copy, JSON.stringify(written))
  expect(await main(['check'], world)).toBe(1)
  expect(said.at(-1)).toContain("1.21.7 (772) wasn't reported from its own jar")
})

test('a release whose layout the edge can’t write stops a bump, and nothing is written', async () => {
  const { world } = worldOf({
    transfer: `  static {};
       0: getstatic     #49                 // Field net/minecraft/network/codec/ByteBufCodecs.STRING_UTF8:Lnet/minecraft/network/codec/StreamCodec;
`,
  })
  await expect(main(['bump'], world)).rejects.toThrow(
    `1.21.7: ${PACKETS.transfer} is written as [ByteBufCodecs.STRING_UTF8], a layout the edge's dialog hold can't write`,
  )
  expect(existsSync(world.copy)).toBe(false)
})

test('check names an entry with no layouts the edge writes', async () => {
  const { world, said } = worldOf()
  await main(['bump'], world)
  const written = JSON.parse(readFileSync(world.copy, 'utf8'))
  delete written.protocols[0].layouts
  written.protocols[1].layouts.transfer = 'host+port+cookies'
  writeFileSync(world.copy, JSON.stringify(written))
  expect(await main(['check'], world)).toBe(1)
  expect(said.at(-1)).toBe(
    `${world.copy}: 1.21.7 (772) has no layouts the edge writes; 1.21.6 (771) has no layouts the edge writes: run bump`,
  )
})

test('every protocol in the copy has layouts the edge writes', () => {
  for (const entry of held.protocols) expect(packetsFor(entry.protocol)?.layouts).toEqual(entry.layouts)
})

test('a jar that isn’t Mojang’s, a server that fails, a release the manifest lacks and a refused manifest stop a bump', async () => {
  await expect(main(['bump'], worldOf({ jar: new Uint8Array([1]) }).world)).rejects.toThrow(
    "1.21.7's server jar isn't the one Mojang names",
  )
  await expect(main(['bump'], worldOf({ exit: 3 }).world)).rejects.toThrow("1.21.7's report failed")
  await expect(main(['bump'], worldOf({ status: 503 }).world)).rejects.toThrow(
    'version_manifest_v2.json answered 503',
  )
  const { world } = worldOf()
  writeFileSync(world.releases, JSON.stringify({ releases: [{ name: '1.21.9', protocol: 773 }] }))
  await expect(main(['bump'], world)).rejects.toThrow("Mojang's manifest has no 1.21.9")
})

test('anything but bump or check is told how to run it', async () => {
  const { world, said } = worldOf()
  expect(await main([], world)).toBe(2)
  expect(said).toEqual(['usage: bun scripts/hold-packets.ts bump | check'])
})
