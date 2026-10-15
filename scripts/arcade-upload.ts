// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Puts the Arcade's world into a deployment's archive store, where a new Arcade server fetches it
 * and where the control plane looks before it offers the Arcade at all (`app/setups/starters.ts`):
 *
 *     ARCHIVE_S3_ENDPOINT=… ARCHIVE_S3_BUCKET=… ARCHIVE_S3_ACCESS_KEY_ID=… \
 *       ARCHIVE_S3_SECRET_ACCESS_KEY=… [ARCHIVE_S3_REGION=…] bun scripts/arcade-upload.ts <archive>
 *
 * The variables are the control plane's own, for the deployment it goes to; nothing here prints
 * one. The archive is the one `scripts/arcade-world.ts` packs, and it must be the very bytes
 * `ARCADE_WORLD` names: anything else is refused before the store is touched. It is stored under
 * its sha512 (`artifacts/<sha512>`), as the control plane keeps a pack it builds, so running it
 * again, or against a store that has it, changes nothing.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { S3ArchiveStore } from '../apps/control/src/infra/s3/s3-archive-store.ts'
import { ARCADE_WORLD } from '../apps/control/src/minecraft/arcade/maps.ts'

const say = (line: string) => process.stdout.write(`${line}\n`)
const need = (name: string): string => {
  const value = process.env[name]
  if (!value)
    throw new Error(`${name} is not set: the archive store's variables, as the control plane has them`)
  return value
}

const path = process.argv[2]
if (path === undefined)
  throw new Error('Name the archive: bun scripts/arcade-upload.ts <arcade-world.tar.gz>')
const bytes = readFileSync(path)
const sha512 = createHash('sha512').update(bytes).digest('hex')
if (sha512 !== ARCADE_WORLD.sha512 || bytes.length !== ARCADE_WORLD.sizeBytes)
  throw new Error(
    `${path} is not the archive ARCADE_WORLD names (its sha512 is ${sha512}, ${bytes.length} bytes)`,
  )
if (ARCADE_WORLD.ref.kind !== 'stored') throw new Error('ARCADE_WORLD is not kept in the archive store')

const store = new S3ArchiveStore({
  endpoint: need('ARCHIVE_S3_ENDPOINT'),
  bucket: need('ARCHIVE_S3_BUCKET'),
  region: process.env.ARCHIVE_S3_REGION || 'auto',
  accessKeyId: need('ARCHIVE_S3_ACCESS_KEY_ID'),
  secretAccessKey: need('ARCHIVE_S3_SECRET_ACCESS_KEY'),
})
const there = await store.head(ARCADE_WORLD.ref.key)
const key = await store.ingestFile(path, sha512)
if (key !== ARCADE_WORLD.ref.key) throw new Error(`The store keeps it as ${key}, not ${ARCADE_WORLD.ref.key}`)
say(
  there === null
    ? `Stored the Arcade's world as ${key}.`
    : `The Arcade's world was already stored as ${key}.`,
)
