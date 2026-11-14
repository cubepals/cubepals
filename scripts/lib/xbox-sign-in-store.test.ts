// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Bedrock test account's sealed sign-in: what is sealed opens again only unchanged and with the
 * same key, names no file outside its directory, is opened where only this user reads it, and goes
 * back to the store only when a run renewed it. The store here is in memory.
 */
import { expect, test } from 'bun:test'
import { createCipheriv } from 'node:crypto'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  open,
  readCache,
  SignInMissing,
  type SignInStore,
  seal,
  sealingKey,
  withSignIn,
  writeCache,
} from './xbox-sign-in-store.ts'

const KEY = sealingKey('staging auth secret')
const FILES = {
  'a1b2c3_live-cache.json': '{"token":{"refresh_token":"M.R3_secret-refresh"}}',
  'a1b2c3_xbl-cache.json': '{"userToken":"xbl"}',
}

/** A store in memory, counting what was put. */
function memoryStore(
  initial: Uint8Array | null,
): SignInStore & { puts: Uint8Array[]; held: () => Uint8Array | null } {
  let held = initial
  const puts: Uint8Array[] = []
  return {
    puts,
    held: () => held,
    async get() {
      return held
    },
    async put(sealed) {
      puts.push(sealed)
      held = sealed
    },
    async forget() {
      held = null
    },
  }
}

test('a sealed sign-in opens to the same files, and its plaintext appears nowhere in it', () => {
  const sealed = seal(FILES, KEY)
  expect(open(sealed, KEY)).toEqual(FILES)
  const text = sealed.toString('latin1')
  expect(text).not.toContain('M.R3_secret-refresh')
  expect(text).not.toContain('live-cache')
  // A fresh IV each time: the same files never seal to the same bytes.
  expect(seal(FILES, KEY).equals(sealed)).toBe(false)
})

test('a changed byte, another key or another version is refused, not used', () => {
  const sealed = seal(FILES, KEY)
  const flipped = Buffer.from(sealed)
  flipped[20] = (flipped[20] ?? 0) ^ 1
  expect(() => open(flipped, KEY)).toThrow(SignInMissing)
  expect(() => open(sealed, sealingKey('another auth secret'))).toThrow(SignInMissing)
  const later = Buffer.from(sealed)
  later[0] = 2
  expect(() => open(later, KEY)).toThrow(SignInMissing)
  expect(() => open(Buffer.alloc(4), KEY)).toThrow(SignInMissing)
})

test('a file name that leaves the directory is refused, sealing and opening', () => {
  for (const name of ['../escape.json', 'nested/file.json', '..', '']) {
    expect(() => seal({ [name]: 'x' }, KEY)).toThrow(SignInMissing)
  }
  // Sealed by someone holding the key, still refused on the way out.
  const iv = Buffer.alloc(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const body = Buffer.concat([cipher.update(JSON.stringify({ '../x': 'y' })), cipher.final()])
  expect(() => open(Buffer.concat([Buffer.from([1]), iv, body, cipher.getAuthTag()]), KEY)).toThrow(
    SignInMissing,
  )
})

test('the sign-in is opened into a directory only this user reads, and deleted after', async () => {
  const store = memoryStore(seal(FILES, KEY))
  let seen = ''
  await withSignIn(store, KEY, async (dir) => {
    seen = dir
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    for (const name of Object.keys(FILES)) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600)
    expect(readCache(dir)).toEqual(FILES)
  })
  expect(existsSync(seen)).toBe(false)
})

test('the sign-in is written back only when the join renewed it, and when the join failed too', async () => {
  const unchanged = memoryStore(seal(FILES, KEY))
  await withSignIn(unchanged, KEY, async () => undefined)
  expect(unchanged.puts).toHaveLength(0)

  const renewed = memoryStore(seal(FILES, KEY))
  await withSignIn(renewed, KEY, async (dir) => {
    writeFileSync(join(dir, 'a1b2c3_live-cache.json'), '{"token":{"refresh_token":"M.R3_next"}}')
  })
  expect(renewed.puts).toHaveLength(1)
  expect(open(renewed.held() ?? new Uint8Array(), KEY)['a1b2c3_live-cache.json']).toContain('M.R3_next')

  const failedAfterRenewing = memoryStore(seal(FILES, KEY))
  await expect(
    withSignIn(failedAfterRenewing, KEY, async (dir) => {
      writeCache(dir, { 'a1b2c3_live-cache.json': '{"token":{"refresh_token":"M.R3_after"}}' })
      throw new Error('the player did not spawn')
    }),
  ).rejects.toThrow('the player did not spawn')
  expect(failedAfterRenewing.puts).toHaveLength(1)
})

test('with nothing stored, the join is not tried and the account is to be signed in again', async () => {
  let called = false
  await expect(
    withSignIn(memoryStore(null), KEY, async () => {
      called = true
    }),
  ).rejects.toThrow(SignInMissing)
  expect(called).toBe(false)
  expect(() => sealingKey('')).toThrow('auth secret')
})
