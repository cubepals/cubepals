// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { appRouter } from './router.ts'
import { inputInWords, type Services } from './trpc.ts'

// tRPC refuses some procedure names only when the router is built, which types don't catch.
describe('the API router', () => {
  test('builds, with every area and procedure reachable', () => {
    const procedures = Object.keys(appRouter._def.procedures)
    for (const path of [
      'servers.get',
      'servers.planVersion',
      'servers.relocate',
      'mods.plan',
      'mods.change',
      'backups.restore',
      'worlds.switch',
      'access.get',
      'console.run',
      'account.me',
      'admin.accounts',
      'admin.suspend',
      'backups.beginUpload',
      'mods.finishUpload',
      'platform.capabilities',
      'admin.alerts',
      'admin.platform',
      'admin.setPlatform',
      'admin.refreshCatalog',
      'admin.stuck',
      'admin.retryOperation',
      'admin.discardOperation',
      'admin.audit',
      'admin.coupons.list',
      'admin.coupons.create',
      'admin.coupons.delete',
      'listings.star',
      'listings.notes',
      'listings.addNote',
      'listings.deleteNote',
    ])
      expect(procedures).toContain(path)
  })
})

describe('admin procedures', () => {
  // Only the guard runs: a caller that isn't an admin never reaches a service.
  const services = (admin: boolean) =>
    ({
      accounts: { isAdmin: async () => admin, suspend: async () => undefined },
      accountQueries: { list: async () => ({ accounts: [], total: 0 }) },
    }) as unknown as Services

  test('answer "not found" to anyone who is not an admin, and run for admins as `admin`', async () => {
    const user = { kind: 'user' as const, userId: 'u-1' }
    const outsider = appRouter.createCaller({ actor: user, services: services(false) })
    await expect(outsider.admin.accounts({ search: '' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(outsider.admin.suspend({ userId: 'u-2', reason: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(outsider.admin.stuck()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      outsider.admin.discardOperation({ operationId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const anonymous = appRouter.createCaller({ actor: null, services: services(true) })
    await expect(anonymous.admin.accounts({ search: '' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    const admin = appRouter.createCaller({ actor: user, services: services(true) })
    expect(await admin.admin.accounts({ search: '' })).toEqual({ total: 0, accounts: [] })
  })
})

describe('coupons', () => {
  const asked: unknown[][] = []
  const services = (admin: boolean) =>
    ({
      accounts: { isAdmin: async () => admin },
      billing: {
        coupons: {
          list: async (...args: unknown[]) => asked.push(['list', ...args]) && [],
          create: async (...args: unknown[]) => asked.push(['create', ...args]) && { id: 'c-1' },
          delete: async (...args: unknown[]) => void asked.push(['delete', ...args]),
        },
      },
    }) as unknown as Services
  const user = { kind: 'user' as const, userId: 'u-1' }
  const coupon = {
    code: 'FRIENDS20',
    off: { kind: 'percent' as const, percent: 20 },
    duration: { kind: 'months' as const, months: 3 },
    maxRedemptions: null,
    endsAt: '2026-12-31T23:59:59.000Z',
  }

  test('are for admins only, and reach the coupon service as `admin`', async () => {
    const outsider = appRouter.createCaller({ actor: user, services: services(false) })
    await expect(outsider.admin.coupons.list()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(outsider.admin.coupons.create(coupon)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(outsider.admin.coupons.delete({ couponId: 'c-1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(asked).toEqual([])

    const admin = appRouter.createCaller({ actor: user, services: services(true) })
    const actor = { kind: 'admin', userId: 'u-1' }
    expect(await admin.admin.coupons.list()).toEqual([])
    expect(await admin.admin.coupons.create(coupon)).toMatchObject({ id: 'c-1' })
    await admin.admin.coupons.delete({ couponId: 'c-1' })
    expect(asked).toEqual([
      ['list', actor],
      ['create', actor, coupon],
      ['delete', actor, 'c-1'],
    ])
  })

  test('refuse a code that is not 3 to 32 letters and digits, and more than 100% off', async () => {
    const admin = appRouter.createCaller({ actor: user, services: services(true) })
    await expect(admin.admin.coupons.create({ ...coupon, code: 'NO SPACES' })).rejects.toThrow(
      'A code is 3 to 32 letters and digits, with no spaces.',
    )
    await expect(
      admin.admin.coupons.create({ ...coupon, off: { kind: 'percent', percent: 120 } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('stars and notes', () => {
  // A signed-out caller is asked to sign in before anything reaches the guestbook.
  const services = {
    guestbook: {
      star: async () => ({ stars: 1, starred: true }),
      notes: async () => ({ notes: [], total: 0 }),
      addNote: async () => ({ notes: [], total: 1 }),
      deleteNote: async () => ({ notes: [], total: 0 }),
    },
  } as unknown as Services
  const serverId = '00000000-0000-4000-8000-000000000000'

  test('ask anyone signed out to sign in, and reach the guestbook for everyone else', async () => {
    const anonymous = appRouter.createCaller({ actor: null, services })
    const unauthorized = { code: 'UNAUTHORIZED' }
    await expect(anonymous.listings.star({ serverId, starred: true })).rejects.toMatchObject(unauthorized)
    await expect(anonymous.listings.notes({ serverId })).rejects.toMatchObject(unauthorized)
    await expect(anonymous.listings.addNote({ serverId, body: 'Great builds' })).rejects.toMatchObject(
      unauthorized,
    )
    await expect(anonymous.listings.deleteNote({ noteId: serverId })).rejects.toMatchObject(unauthorized)

    const signedIn = appRouter.createCaller({ actor: { kind: 'user', userId: 'u-1' }, services })
    expect(await signedIn.listings.star({ serverId, starred: true })).toEqual({ stars: 1, starred: true })
    expect(await signedIn.listings.notes({ serverId })).toEqual({ notes: [], total: 0 })
  })
})

describe('an input the contracts refuse', () => {
  const refused = (schema: z.ZodType, value: unknown) => {
    const parsed = schema.safeParse(value)
    if (parsed.success) throw new Error('expected a refusal')
    return inputInWords(parsed.error)
  }

  test('is said in a sentence, never as the list of Zod issues', () => {
    expect(refused(z.string().max(256), 'x'.repeat(300))).toBe('That’s too long: up to 256 characters.')
    expect(refused(z.string().trim().min(1), '  ')).toBe('That can’t be empty.')
    expect(refused(z.string().min(3), 'ab')).toBe('That’s too short: at least 3 characters.')
    expect(refused(z.number().int().max(1000), 5000)).toBe('Pick a number up to 1000.')
    expect(refused(z.uuid(), 'not-an-id')).toBe('That doesn’t look right. Check it and try again.')
    for (const said of [refused(z.object({ a: z.string() }), {}), refused(z.email(), 'nope')])
      expect(said.startsWith('[')).toBe(false)
  })

  test('keeps a sentence a schema wrote for people', () => {
    expect(refused(z.string().max(5, 'Names can be up to 5 letters.'), 'toolong')).toBe(
      'Names can be up to 5 letters.',
    )
  })
})
