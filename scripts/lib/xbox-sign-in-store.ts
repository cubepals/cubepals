// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the Bedrock test account's Xbox sign-in waits between runs: prismarine-auth's cache
 * directory, sealed with AES-256-GCM and kept as one object in staging's bucket. A run opens it into
 * a private directory, joins with it (`tools/bedrock-join/signed-in.ts`), and writes it back when
 * the join renewed it (Microsoft's refresh token changes as it is used), then deletes the directory.
 *
 * The key is derived from staging's own auth secret (STAGING_STATE's `authSecret`), which only the
 * staging environment holds: main's runs, never a pull request's. The preview environment holds the
 * bucket's keys, so it could read the sealed object or remove it, but never open it, and a sealed
 * object made with any other key is refused, not used. A new auth secret makes the stored sign-in
 * unreadable: the account is signed in again.
 *
 * Not for signing the account in (`scripts/bedrock-xbox-sign-in.ts`) or for joining.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { Bucket } from '../preview-uploads.ts'

/** The bucket object the sealed sign-in is kept as. */
const OBJECT_KEY = 'bedrock-check/xbox-sign-in.v1'
/** Binds the derived key to this use, so staging's auth secret yields nothing usable elsewhere. */
const INFO = 'cubepals bedrock check xbox sign-in v1'
const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16

/** Where the account must be signed in again: no sign-in is stored, or it can't be opened. */
export class SignInMissing extends Error {}

/** The sealing key, the same for the same auth secret. */
export function sealingKey(authSecret: string): Buffer {
  if (authSecret === '') throw new Error('the sign-in’s key needs staging’s auth secret (STAGING_STATE)')
  return Buffer.from(hkdfSync('sha256', authSecret, Buffer.alloc(0), INFO, 32))
}

/** The cache's files, name to contents, sealed: a version byte, the IV, the ciphertext and its tag. */
export function seal(files: Record<string, string>, key: Buffer): Buffer {
  for (const name of Object.keys(files)) plainName(name)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(files), 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), iv, body, cipher.getAuthTag()])
}

/** The files a sealed object holds; refused when it was changed, sealed with another key, or isn't this version. */
export function open(sealed: Uint8Array, key: Buffer): Record<string, string> {
  const bytes = Buffer.from(sealed)
  if (bytes.length < 1 + IV_BYTES + TAG_BYTES || bytes[0] !== VERSION)
    throw new SignInMissing('the stored sign-in is not one this version reads')
  const iv = bytes.subarray(1, 1 + IV_BYTES)
  const tag = bytes.subarray(bytes.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  let plain: string
  try {
    plain = Buffer.concat([
      decipher.update(bytes.subarray(1 + IV_BYTES, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new SignInMissing('the stored sign-in was changed, or sealed with another key')
  }
  const files = JSON.parse(plain) as Record<string, unknown>
  for (const [name, contents] of Object.entries(files)) {
    plainName(name)
    if (typeof contents !== 'string') throw new SignInMissing(`the stored sign-in's ${name} is not text`)
  }
  return files as Record<string, string>
}

/** A file name the cache may hold: no directory, no way out of the directory. */
function plainName(name: string): void {
  if (name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name))
    throw new SignInMissing(`the stored sign-in names a file it may not: ${JSON.stringify(name)}`)
}

/** The cache directory's files. */
export function readCache(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const name of readdirSync(dir).sort()) files[name] = readFileSync(join(dir, name), 'utf8')
  return files
}

/** The files, into the directory, readable by this user alone. */
export function writeCache(dir: string, files: Record<string, string>): void {
  chmodSync(dir, 0o700)
  for (const [name, contents] of Object.entries(files)) {
    plainName(name)
    writeFileSync(join(dir, name), contents, { mode: 0o600 })
    chmodSync(join(dir, name), 0o600)
  }
}

/** Where the sealed sign-in is kept. */
export interface SignInStore {
  get(): Promise<Uint8Array | null>
  put(sealed: Uint8Array): Promise<void>
  forget(): Promise<void>
}

/** The sealed sign-in as one object in staging's bucket. */
export function bucketStore(bucket: Bucket): SignInStore {
  const client = new S3Client({
    endpoint: bucket.endpoint,
    region: bucket.region,
    credentials: { accessKeyId: bucket.accessKeyId, secretAccessKey: bucket.secretAccessKey },
  })
  return {
    async get() {
      try {
        const got = await client.send(new GetObjectCommand({ Bucket: bucket.name, Key: OBJECT_KEY }))
        return got.Body === undefined ? null : await got.Body.transformToByteArray()
      } catch (error) {
        if (error instanceof NoSuchKey) return null
        throw error
      }
    },
    async put(sealed) {
      await client.send(new PutObjectCommand({ Bucket: bucket.name, Key: OBJECT_KEY, Body: sealed }))
    },
    async forget() {
      await client.send(new DeleteObjectCommand({ Bucket: bucket.name, Key: OBJECT_KEY }))
    },
  }
}

const sameFiles = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

/**
 * Runs `use` with the stored sign-in opened into a private directory, writes it back sealed if it
 * changed (even when `use` failed: a renewed sign-in may have replaced the stored one's refresh
 * token), and deletes the directory whatever happened. With nothing stored it throws
 * {@link SignInMissing} without calling `use`. `use`'s own failure is the one thrown.
 */
export async function withSignIn<T>(
  store: SignInStore,
  key: Buffer,
  use: (dir: string) => Promise<T>,
): Promise<T> {
  const sealed = await store.get()
  if (sealed === null) throw new SignInMissing('no Xbox sign-in is stored for the Bedrock test account')
  const before = open(sealed, key)
  const dir = mkdtempSync(join(tmpdir(), 'bedrock-xbox-'))
  try {
    writeCache(dir, before)
    let result: T
    try {
      result = await use(dir)
    } catch (error) {
      await writeBack(store, key, before, dir).catch((stored: Error) =>
        console.warn(`the renewed Xbox sign-in could not be stored: ${stored.message}`),
      )
      throw error
    }
    await writeBack(store, key, before, dir)
    return result
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The directory's files, sealed into the store, where they differ from what was opened. */
async function writeBack(
  store: SignInStore,
  key: Buffer,
  before: Record<string, string>,
  dir: string,
): Promise<void> {
  const after = readCache(dir)
  if (!sameFiles(before, after)) await store.put(seal(after, key))
}
