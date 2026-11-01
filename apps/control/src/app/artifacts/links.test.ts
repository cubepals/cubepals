// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Runtime artifact links remain stable, scoped to their server and signed by the current key. */
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { ModArtifact } from '../../domain/mods/artifact.ts'
import { diskName } from '../../minecraft/jars.ts'
import { deriveServerSecret, singleKey } from '../secrets.ts'
import { ArtifactLinks } from './links.ts'

const base = 'https://runtime.example.test'
const serverId = crypto.randomUUID()
const key = 'runtime-links-fixture'
const artifact: ModArtifact = {
  ref: { kind: 'stored', key: 'fixture' },
  sha512: createHash('sha512').update('artifact fixture').digest('hex'),
  sizeBytes: 16,
  fileName: 'a mod+#?.jar',
}

test('public icons encode their identity and carry no per-server token', () => {
  for (const root of [base, `${base}/`]) {
    const links = new ArtifactLinks(root, singleKey(key))
    expect(links.icon('grass')).toBe(`${base}/runtime/v1/icons/grass.png`)
    expect(links.icon('a/b +?#')).toBe(`${base}/runtime/v1/icons/a%2Fb%20%2B%3F%23.png`)
  }
})

test('private pictures, reporter posts and artifacts share the server token and exact paths', () => {
  for (const root of [base, `${base}/`]) {
    const links = new ArtifactLinks(root, singleKey(key))
    const token = deriveServerSecret(key, serverId, 'artifacts')
    const sha256 = createHash('sha256').update('picture fixture').digest('hex')
    expect(links.ownIcon(serverId, sha256)).toBe(
      `${base}/runtime/v1/icons/${serverId}/${sha256}.png?t=${token}`,
    )
    expect(links.joinsReport(serverId)).toBe(`${base}/runtime/v1/servers/${serverId}/joins?t=${token}`)
    expect(links.forServer(serverId)(artifact)).toBe(
      `${base}/runtime/v1/artifacts/${serverId}/${artifact.sha512}/${encodeURIComponent(diskName(artifact))}?t=${token}`,
    )
    expect(links.forServer(serverId)(artifact)).toBe(links.forServer(serverId)(artifact))
    const other = crypto.randomUUID()
    expect(new URL(links.joinsReport(other)).searchParams.get('t')).toBe(
      deriveServerSecret(key, other, 'artifacts'),
    )
    expect(links.joinsReport(other)).not.toBe(links.joinsReport(serverId))
  }
})

test('rotation signs new links with the current key rather than an accepted old key', () => {
  const current = { version: 2, key: 'rotated-runtime-key' }
  const links = new ArtifactLinks(base, { current, previous: [{ version: 1, key }] })
  const expected = deriveServerSecret(current.key, serverId, 'artifacts')
  for (const link of [
    links.ownIcon(serverId, 'picture'),
    links.joinsReport(serverId),
    links.forServer(serverId)(artifact),
  ]) {
    expect(new URL(link).searchParams.get('t')).toBe(expected)
    expect(new URL(link).searchParams.get('t')).not.toBe(deriveServerSecret(key, serverId, 'artifacts'))
  }
})
