// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The real universal Zoomify jar's declarations stay separate for Fabric and NeoForge. */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { foreignDependency, nativeFor } from '../../domain/mods/loader-dependencies.ts'
import { LibraryFileFormats } from '../../infra/formats/file-formats.ts'
import { loaderMetadata } from '../../minecraft/loader-metadata.ts'

const fixture = (file: string) =>
  readFileSync(new URL(`../../minecraft/fixtures/zoomify/${file}`, import.meta.url), 'utf8')
function metadata() {
  return loaderMetadata({
    'fabric.mod.json': JSON.parse(fixture('fabric.mod.json')),
    'META-INF/neoforge.mods.toml': new LibraryFileFormats().decode('toml', fixture('neoforge.mods.toml')),
  })
}
const target = { loader: 'fabric', loaders: ['fabric'] }
const source = JSON.parse(fixture('source.json'))
const parent = { loaders: source.loaders, file: { sha512: source.sha512 } } as Parameters<
  typeof foreignDependency
>[1]

test('the actual universal jar gives each loader its own required mods', () => {
  const native = metadata()
  expect(native.fabric?.depends).toEqual(['yet_another_config_lib_v3'])
  expect(native.neoforge?.depends).toEqual(['yet_another_config_lib_v3'])
  expect(native.fabric?.version).toBe('2.17.0+mc26.3')
  expect(native.fabric?.complete).toBe(true)
  expect(nativeFor(target, { java: null, api: null, native })?.ids).toEqual(['zoomify'])
  expect(
    nativeFor({ loader: 'neoforge', loaders: ['neoforge'] }, { java: null, api: null, native })?.ids,
  ).toEqual(['zoomify'])
})

test('a complete universal jar excludes a proven foreign-loader edge, without guessing on unknowns', () => {
  const native = metadata()
  const fabric = native.fabric
  if (fabric === undefined) throw new Error('Zoomify fixture has no Fabric declaration')
  const needs = { java: null, api: null, native }
  expect(foreignDependency(target, parent, needs, { loaders: ['forge', 'neoforge'] })).toBe(true)
  expect(foreignDependency(target, parent, needs, { loaders: ['fabric', 'forge'] })).toBe(false)
  expect(foreignDependency(target, parent, needs, null)).toBe(false)
  expect(foreignDependency(target, parent, null, { loaders: ['forge'] })).toBe(false)
  expect(foreignDependency(target, { ...parent, loaders: ['fabric'] }, needs, { loaders: ['forge'] })).toBe(
    false,
  )
  expect(
    foreignDependency(
      target,
      parent,
      { ...needs, native: { fabric: { ...fabric, complete: false } } },
      { loaders: ['forge'] },
    ),
  ).toBe(false)
  expect(
    foreignDependency(
      target,
      parent,
      { ...needs, native: { fabric: { ...fabric, environment: 'client' } } },
      { loaders: ['forge'] },
    ),
  ).toBe(false)
})

test('an unsupported declaration remains unknown and Quilt can read a Fabric declaration', () => {
  const native = metadata()
  expect(loaderMetadata({})).toEqual({})
  expect(
    nativeFor({ loader: 'quilt', loaders: ['quilt', 'fabric'] }, { java: null, api: null, native })?.ids,
  ).toEqual(['zoomify'])
  expect(
    nativeFor({ loader: 'forge', loaders: ['forge'] }, { java: null, api: null, native }),
  ).toBeUndefined()
  expect(loaderMetadata({ 'fabric.mod.json': { id: 'bad', depends: { unknown: 2 } } }).fabric?.complete).toBe(
    false,
  )
})

test('server declarations keep valid ranges and incomplete requirements cannot drop catalog edges', () => {
  const declared = loaderMetadata({
    'fabric.mod.json': { id: 'server', environment: 'server', depends: { library: ['>=1', 2] } },
    'META-INF/mods.toml': {
      clientSideOnly: true,
      mods: [{ modId: 'server' }],
      dependencies: {
        server: [
          { modId: 'library', mandatory: true, versionRange: ['[1,)', 2] },
          { modId: 'unknown-range', mandatory: true },
          { modId: 'client-library', mandatory: true, side: 'CLIENT', versionRange: '*' },
          { mandatory: true, versionRange: '*' },
          { modId: 'optional-library', mandatory: false, versionRange: '*' },
        ],
      },
    },
  })
  expect(declared.fabric?.requirements).toEqual([{ id: 'library', versions: ['>=1'] }])
  expect(declared.fabric?.environment).toBe('server')
  expect(declared.forge?.environment).toBe('client')
  expect(declared.forge?.depends).toEqual(['library', 'unknown-range'])
  expect(declared.forge?.complete).toBe(false)
  expect(nativeFor({ loaders: [] }, { java: null, api: null, native: declared })).toBeUndefined()
})

test('nested Forge libraries defer missing-id judgments to the real loader', () => {
  const decoded = {
    'META-INF/neoforge.mods.toml': new LibraryFileFormats().decode('toml', fixture('neoforge.mods.toml')),
  }
  expect(loaderMetadata(decoded).neoforge?.carriesJars).toBe(false)
  expect(loaderMetadata(decoded, ['META-INF/jarjar/library.jar']).neoforge?.carriesJars).toBe(true)
})

test('loader sides and complete dependency ranges survive absent or built-in declarations', () => {
  for (const environment of ['client', 'server', '*', undefined]) {
    const result = loaderMetadata({
      'fabric.mod.json': { id: 'example', environment, depends: { a: '*', b: undefined } },
    })
    expect(result.fabric?.environment).toBe(
      environment === 'client' || environment === 'server' ? environment : 'both',
    )
    expect(result.fabric?.complete).toBe(false)
  }
  const result = loaderMetadata(
    {
      'META-INF/mods.toml': {
        mods: [{ modId: 'example' }, {}],
        dependencies: {
          example: ['minecraft', 'forge', 'neoforge', 'java', 'library'].map((modId) => ({
            modId,
            mandatory: true,
            versionRange: '[1,)',
          })),
        },
      },
    },
    ['META-INF/notes.txt'],
  )
  expect(result.forge).toEqual({
    ids: ['example'],
    depends: ['library'],
    requirements: ['minecraft', 'forge', 'neoforge', 'java', 'library'].map((id) => ({
      id,
      versions: ['[1,)'],
    })),
    version: null,
    environment: 'both',
    carriesJars: false,
    complete: true,
  })
  expect(loaderMetadata({ 'META-INF/mods.toml': { mods: [{}] } })).toEqual({})
})
