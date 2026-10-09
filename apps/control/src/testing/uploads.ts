import { gzipSync } from 'node:zlib'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import nbt from 'prismarine-nbt'

/** A Fabric mod's jar, declaring itself as a real one does; `fields` overrides its fabric.mod.json. */
export const fabricJar = (id: string, fields: Record<string, unknown> = {}): Uint8Array =>
  zipSync({
    'fabric.mod.json': strToU8(
      JSON.stringify({
        schemaVersion: 1,
        id,
        name: `Mod ${id}`,
        version: '1.0.0',
        environment: '*',
        depends: { minecraft: '>=26' },
        ...fields,
      }),
    ),
    [`net/example/${id}/Mod.class`]: new Uint8Array([0xca, 0xfe, 0xba, 0xbe, ...strToU8(id)]),
  })

/** A zip holding the given text files: a jar with whatever metadata a test needs. */
export const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])))

/** A world's level.dat as the game writes it: gzipped NBT naming the version that saved it. */
export const levelDat = (version: string): Uint8Array =>
  gzipSync(
    nbt.writeUncompressed({
      type: 'compound',
      name: '',
      value: {
        Data: {
          type: 'compound',
          value: {
            DataVersion: { type: 'int', value: 5023 },
            Version: { type: 'compound', value: { Name: { type: 'string', value: version } } },
          },
        },
      },
    }),
  )

/** A zip of the given files, as a test uploads one: an app test never reaches for the zip library. */
export const zipBytes = (files: Record<string, Uint8Array>): Uint8Array => zipSync(files)

/** A zip's files by name, as a test reads what Blockly built. */
export const unzipBytes = (bytes: Uint8Array): Record<string, Uint8Array> => unzipSync(bytes)

export const utf8 = (text: string): Uint8Array => strToU8(text)
export const textOf = (bytes: Uint8Array): string => strFromU8(bytes)
