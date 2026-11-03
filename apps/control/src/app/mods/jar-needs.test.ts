// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading what a catalog jar asks of a server by byte ranges, and keeping it with the version, from
 * the header of BentoBox's own main class.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { CatalogVersion } from '../../domain/mods/catalog.ts'
import { LibraryFileFormats } from '../../infra/formats/file-formats.ts'
import { Cdn } from '../../testing/cdn.ts'
import { type Harness, hasDatabase, startHarness } from '../../testing/harness.ts'
import { utf8, zipBytes } from '../../testing/uploads.ts'
import { JarNeedsReader } from './jar-needs.ts'

/**
 * The first 48 bytes of BentoBox 3.23.3's main class, `world/bentobox/bentobox/BentoBox.class`, as
 * Modrinth serves it (version Wm9asg4I, read 2026-10-11): class file 69, Java 25's. Paper 1.21.11 on
 * Java 21 refused it in production with an UnsupportedClassVersionError.
 */
const BENTOBOX_3_23_3_MAIN = Buffer.from(
  'cafebabe0000004503b40a000200030700040c000500060100216f72672f62756b6b69742f706c7567696e2f6a617661',
  'hex',
)
/** The same class in BentoBox 3.12.0 (version AbNCctdZ): class file 65, Java 21's. */
const BENTOBOX_3_12_0_MAIN = Buffer.from(BENTOBOX_3_23_3_MAIN).fill(0x41, 7, 8)
/** A library shaded in for Java 8, ahead of the main class in the jar's directory. */
const SHADED_JAVA_8 = Buffer.from('cafebabe00000034', 'hex')

const bentobox = (main: Buffer) =>
  zipBytes({
    'META-INF/MANIFEST.MF': utf8('Manifest-Version: 1.0\n'),
    'org/bstats/Metrics.class': SHADED_JAVA_8,
    'plugin.yml': utf8('name: BentoBox\nmain: world.bentobox.bentobox.BentoBox\nversion: 3.23.3\n'),
    'world/bentobox/bentobox/BentoBox.class': main,
  })

/** A BentoBox version as the catalog lists it, its jar at `url`. */
const version = (versionId: string, url: string): CatalogVersion => ({
  versionId,
  projectId: 'aBVLHiAW',
  versionLabel: versionId,
  channel: 'release',
  state: 'listed',
  environment: 'server_only',
  loaders: ['paper'],
  gameVersions: ['1.21.11', '26.2'],
  publishedAt: new Date('2026-10-03'),
  file: { url, sha512: versionId.padEnd(128, '0'), sizeBytes: 1, fileName: 'x.jar' },
  dependencies: [],
})

describe.skipIf(!hasDatabase)('what a catalog jar asks of a server', () => {
  let h: Harness
  const cdn = new Cdn()

  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  const at = (versionId: string, path: string) => version(versionId, `${cdn.url}${path}`)

  test('reads the main class plugin.yml names, by ranges, and keeps what it found', async () => {
    cdn.files.set('/BentoBox-3.23.3.jar', Buffer.from(bentobox(BENTOBOX_3_23_3_MAIN)))
    cdn.files.set('/BentoBox-3.12.0.jar', Buffer.from(bentobox(BENTOBOX_3_12_0_MAIN)))
    const java = new JarNeedsReader({ db: h.db, formats: new LibraryFileFormats() })
    const versions = [at('Wm9asg4I', '/BentoBox-3.23.3.jar'), at('AbNCctdZ', '/BentoBox-3.12.0.jar')]
    expect(await java.of('modrinth', versions)).toEqual(
      new Map([
        ['Wm9asg4I', { java: 25, api: null, mod: null, native: {} }],
        ['AbNCctdZ', { java: 21, api: null, mod: null, native: {} }],
      ]),
    )
    // Nothing was downloaded whole.
    expect(cdn.downloads).toBe(0)
    // Kept with the version: asked again, the jar isn't read again.
    cdn.files.clear()
    const again = new JarNeedsReader({ db: h.db, formats: new LibraryFileFormats() })
    expect((await again.of('modrinth', versions)).get('Wm9asg4I')).toEqual({
      java: 25,
      api: null,
      mod: null,
      native: {},
    })
  })

  test('a jar that can’t be read is unknown, and read again next time', async () => {
    const java = new JarNeedsReader({ db: h.db, formats: new LibraryFileFormats() })
    const missing = at('missing', '/missing.jar')
    expect((await java.of('modrinth', [missing])).get('missing')).toBeNull()
    cdn.files.set('/missing.jar', Buffer.from(bentobox(BENTOBOX_3_23_3_MAIN)))
    expect((await java.of('modrinth', [missing])).get('missing')).toEqual({
      java: 25,
      api: null,
      mod: null,
      native: {},
    })
  })

  test('a BentoBox add-on says the BentoBox it loads on', async () => {
    // AOneBlock 1.28.0's addon.yml, as Modrinth serves it (SO3SQFxw): api-version 3.22.0.
    cdn.files.set(
      '/AOneBlock-1.28.0.jar',
      Buffer.from(
        zipBytes({
          'addon.yml': utf8(
            'name: AOneBlock\nmain: world.bentobox.aoneblock.AOneBlock\napi-version: 3.22.0\n',
          ),
          'world/bentobox/aoneblock/AOneBlock.class': BENTOBOX_3_12_0_MAIN,
        }),
      ),
    )
    const java = new JarNeedsReader({ db: h.db, formats: new LibraryFileFormats() })
    expect((await java.of('modrinth', [at('SO3SQFxw', '/AOneBlock-1.28.0.jar')])).get('SO3SQFxw')).toEqual({
      java: 21,
      api: { projectId: 'aBVLHiAW', atLeast: '3.22.0' },
      mod: null,
      native: {},
    })
  })

  test('metadata-only jars need one directory read', () => metadataOnly(h, cdn))

  test('a Fabric mod says the mods it requires, and one read before that is read again', () =>
    fabricMetadata(h, cdn))
})

// The create page's picker asks for every release at once: Create's own jar lists 12,500 files,
// and production's api ran out of its 480 MB heap reading a handful of such jars on 2026-10-11.
describe.skipIf(!hasDatabase)('many big jars at once', () => {
  let h: Harness
  const cdn = new Cdn()

  beforeAll(async () => {
    await cdn.start()
    h = await startHarness()
  }, 30_000)

  afterAll(async () => {
    await h.close()
    cdn.close()
  })

  test('are read in a bounded memory', async () => {
    const fabricModJson = { id: 'big', entrypoints: { main: ['com.example.big.Big'] } }
    const files: Record<string, Uint8Array> = {
      'fabric.mod.json': utf8(JSON.stringify(fabricModJson)),
      'com/example/big/Big.class': BENTOBOX_3_23_3_MAIN,
    }
    for (let i = 0; i < 20_000; i++) files[`com/example/big/content/Thing${i}Renderer.class`] = SHADED_JAVA_8
    cdn.files.set('/big.jar', Buffer.from(zipBytes(files)))
    const versions = Array.from({ length: 24 }, (_, i) => version(`big-${i}`, `${cdn.url}/big.jar`))
    Bun.gc(true)
    const before = process.memoryUsage().heapUsed
    let peak = before
    const sampling = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().heapUsed)
    }, 1)
    const reader = new JarNeedsReader({ db: h.db, formats: new LibraryFileFormats() })
    const read = await reader.of('modrinth', versions)
    clearInterval(sampling)
    expect([...read.values()].map((needs) => needs?.java)).toEqual(Array(24).fill(25))
    // Every jar at once took 953–968 MB here; bounded, 35–41 MB locally, with room for CI's runners.
    expect((peak - before) / (1024 * 1024)).toBeLessThan(384)
  }, 120_000)
})

async function metadataOnly(h: Harness, cdn: Cdn) {
  cdn.files.set(
    '/metadata-only.jar',
    Buffer.from(zipBytes({ 'fabric.mod.json': utf8(JSON.stringify({ id: 'metadata_only', version: '1' })) })),
  )
  const formats = new LibraryFileFormats()
  const reads = spyOn(formats, 'readRemoteZip')
  try {
    const reader = new JarNeedsReader({ db: h.db, formats })
    const found = await reader.of('modrinth', [version('metadata-only', `${cdn.url}/metadata-only.jar`)])
    expect(found.get('metadata-only')?.java).toBeNull()
    expect(found.get('metadata-only')?.mod?.ids).toEqual(['metadata_only'])
    expect(reads).toHaveBeenCalledTimes(1)
  } finally {
    reads.mockRestore()
  }
}

async function fabricMetadata(h: Harness, cdn: Cdn) {
  const at = (versionId: string, path: string) => version(versionId, `${cdn.url}${path}`)
  // spark 1.10.187-fabric's metadata (e3hsPc1o), cut to what this reads.
  const fabricModJson = {
    id: 'spark',
    entrypoints: { main: ['me.lucko.spark.fabric.FabricSparkMod'] },
    depends: { fabricloader: '>=0.18.4', 'fabric-api-base': '*', 'fabric-permissions-api-v0': '*' },
    jars: [{ file: 'META-INF/jars/fabric-permissions-api-0.7.0.jar' }],
  }
  cdn.files.set(
    '/spark-fabric.jar',
    Buffer.from(
      zipBytes({
        'fabric.mod.json': utf8(JSON.stringify(fabricModJson)),
        'me/lucko/spark/fabric/FabricSparkMod.class': BENTOBOX_3_23_3_MAIN,
      }),
    ),
  )
  const spark = at('e3hsPc1o', '/spark-fabric.jar')
  // As a row kept before the mods were read left it: the Java alone.
  await h.db
    .insert(schema.catalogVersionNeeds)
    .values({ catalog: 'modrinth', versionId: 'e3hsPc1o', java: 25, readAt: new Date() })
  const reader = () => new JarNeedsReader({ db: h.db, formats: new LibraryFileFormats() })
  const fabric = {
    java: 25,
    api: null,
    mod: { ids: ['spark'], depends: ['fabric-api-base'], carriesJars: true },
    native: {
      fabric: {
        ids: ['spark'],
        depends: ['fabric-api-base'],
        carriesJars: true,
        version: null,
        environment: 'both' as const,
        complete: true,
        requirements: [{ id: 'fabric-api-base', versions: ['*'] }],
      },
    },
  }
  expect((await reader().of('modrinth', [spark])).get('e3hsPc1o')).toEqual(fabric)
  for (const missing of ['modIds', 'nativeMetadata', 'fileSha512'] as const) {
    await h.db
      .update(schema.catalogVersionNeeds)
      .set({ [missing]: null })
      .where(eq(schema.catalogVersionNeeds.versionId, spark.versionId))
    expect((await reader().of('modrinth', [spark])).get(spark.versionId)).toEqual(fabric)
    const row = await h.db.query.catalogVersionNeeds.findFirst({
      where: (t, { eq }) => eq(t.versionId, spark.versionId),
    })
    expect(row?.fileSha512).toBe(spark.file.sha512)
    expect(row?.nativeMetadata).toEqual(fabric.native)
  }
  const other = at('other-spark', '/spark-fabric.jar')
  await reader().of('modrinth', [other, spark])
  // Kept, and read from there next time, matched to each version's own digest.
  cdn.files.clear()
  expect((await reader().of('modrinth', [other, spark])).get('e3hsPc1o')).toEqual(fabric)
}
