// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Every public RPC retains its declared input and propagates an owned service refusal. */
import { expect, test } from 'bun:test'
import { OWN_ICON_SIZE } from '@blockly/contracts'
import { PNG } from 'pngjs'
import { z } from 'zod'
import { AppError } from '../../app/errors.ts'
import { appRouter } from './router.ts'

const paths = [
  'access.addHelper',
  'access.addToWhitelist',
  'access.addUnchecked',
  'access.ban',
  'access.deop',
  'access.get',
  'access.op',
  'access.pardon',
  'access.refresh',
  'access.removeFromWhitelist',
  'access.removeHelper',
  'access.removeUnchecked',
  'access.setWhitelist',
  'account.allowExtraPlay',
  'account.me',
  'account.overview',
  'account.recordSource',
  'account.setAfkKick',
  'account.setTimeZone',
  'account.switchBack',
  'admin.account',
  'admin.accounts',
  'admin.alerts',
  'admin.allowlist',
  'admin.audit',
  'admin.compatibility',
  'admin.coupons.create',
  'admin.coupons.delete',
  'admin.coupons.list',
  'admin.createTestAccount',
  'admin.curatedPacks',
  'admin.discardOperation',
  'admin.dismissReport',
  'admin.flySuspend',
  'admin.freeLinks',
  'admin.grantAdmin',
  'admin.health',
  'admin.healthOperations',
  'admin.holdFree',
  'admin.markOfficial',
  'admin.moderate',
  'admin.operationSteps',
  'admin.platform',
  'admin.publishRelease',
  'admin.refreshCatalog',
  'admin.reinstate',
  'admin.releaseFree',
  'admin.removedListings',
  'admin.reports',
  'admin.restoreBackup',
  'admin.retryOperation',
  'admin.retryRelease',
  'admin.revokeAdmin',
  'admin.serverBackups',
  'admin.servers',
  'admin.setEarlyClosed',
  'admin.setFlySuspend',
  'admin.setLimits',
  'admin.setPlan',
  'admin.setPlatform',
  'admin.setRestrictions',
  'admin.setTestAccount',
  'admin.startServer',
  'admin.stopForMaintenance',
  'admin.stuck',
  'admin.suspend',
  'admin.terminate',
  'admin.trashServer',
  'admin.trust',
  'admin.untrashServer',
  'admin.untrust',
  'admin.useAs',
  'admin.withdrawRelease',
  'backups.answerUpload',
  'backups.archive',
  'backups.beginUpload',
  'backups.create',
  'backups.delete',
  'backups.download',
  'backups.downloadState',
  'backups.finishUpload',
  'backups.letInFromUpload',
  'backups.list',
  'backups.restore',
  'backups.upload',
  'billing.checkout',
  'billing.moveTo',
  'billing.offer',
  'billing.plans',
  'billing.portal',
  'billing.refresh',
  'billing.settle',
  'billing.switchPrice',
  'billing.switchable',
  'chipIns.own',
  'chipIns.setOpen',
  'chipIns.start',
  'console.run',
  'gifts.buy',
  'gifts.mine',
  'gifts.options',
  'gifts.redeem',
  'gifts.resend',
  'insight.answerMoment',
  'insight.dismissMoment',
  'insight.feedback',
  'insight.moment',
  'listings.addNote',
  'listings.browse',
  'listings.deleteNote',
  'listings.get',
  'listings.notes',
  'listings.own',
  'listings.report',
  'listings.setCopyable',
  'listings.setPublic',
  'listings.star',
  'moderation.get',
  'moderation.lift',
  'moderation.punish',
  'moderation.removalsOf',
  'moderation.setLadder',
  'moderation.setStopCheaters',
  'moderation.setTools',
  'moderation.useOurStopCheaters',
  'mods.beginUpload',
  'mods.change',
  'mods.changePack',
  'mods.deleteUpload',
  'mods.finishUpload',
  'mods.list',
  'mods.plan',
  'mods.search',
  'mods.uploads',
  'newWorlds.answerUpload',
  'newWorlds.beginUpload',
  'newWorlds.choosePeople',
  'newWorlds.finishUpload',
  'newWorlds.upload',
  'packs.beginUpload',
  'packs.finishUpload',
  'packs.import',
  'platform.capabilities',
  'platform.joinWaitlist',
  'players.cancel',
  'players.get',
  'players.icons',
  'players.setGameMode',
  'players.teleport',
  'realtime.connectInfo',
  'servers.changeAddress',
  'servers.changeAuthentication',
  'servers.changeBedrock',
  'servers.changeOtherVersions',
  'servers.changeSettings',
  'servers.changeVersion',
  'servers.create',
  'servers.createOptions',
  'servers.delete',
  'servers.get',
  'servers.keep',
  'servers.keepWorld',
  'servers.list',
  'servers.packFromLink',
  'servers.packVersions',
  'servers.planVersion',
  'servers.purgedArchives',
  'servers.relocate',
  'servers.resetInvite',
  'servers.resize',
  'servers.restart',
  'servers.retry',
  'servers.revisions',
  'servers.rollback',
  'servers.saveIdentity',
  'servers.searchModpacks',
  'servers.settingsOptions',
  'servers.setupPreview',
  'servers.setupReleases',
  'servers.start',
  'servers.stop',
  'servers.suggestAddress',
  'servers.trash',
  'servers.undelete',
  'sharing.invite',
  'sharing.inviteOpened',
  'sharing.inviteShared',
  'sharing.join',
  'sharing.own',
  'sharing.page',
  'worlds.create',
  'worlds.delete',
  'worlds.freshStart',
  'worlds.list',
  'worlds.startOver',
  'worlds.switch',
]
const actor = { kind: 'user', userId: crypto.randomUUID() }
const message = 'The requested service refused this operation'
const samples = {
  timeZone: 'UTC',
  terms: new Date().toISOString().slice(0, 10),
  next: '/account',
  playerName: 'Steve',
  name: 'Steve',
  address: 'test-server',
  slug: 'test-server',
  gameVersion: '26.2',
  email: 'player@example.test',
  url: 'https://example.test/file.zip',
}
const picture = PNG.sync.write(new PNG({ width: OWN_ICON_SIZE, height: OWN_ICON_SIZE })).toString('base64')
function example(schema, key = '', root = schema) {
  if (Array.isArray(schema.type))
    return example({ ...schema, type: schema.type.find((type) => type !== 'null') }, key, root)
  if (schema.$ref)
    return example(
      schema.$ref
        .slice(2)
        .split('/')
        .reduce((value, part) => value[part], root),
      key,
      root,
    )
  if (Object.hasOwn(schema, 'const')) return schema.const
  if (schema.enum) return schema.enum[0]
  if (schema.anyOf || schema.oneOf)
    return example(
      (schema.anyOf ?? schema.oneOf).find((value) => value.type !== 'null'),
      key,
      root,
    )
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([name, value]) => [name, example(value, name, root)]),
    )
  if (schema.type === 'array')
    return Array.from({ length: Math.max(1, schema.minItems ?? 0) }, () => example(schema.items, key, root))
  if (schema.type === 'boolean') return true
  if (schema.type === 'null') return null
  if (schema.type === 'integer' || schema.type === 'number')
    return Math.min(schema.maximum ?? Infinity, Math.max(schema.minimum ?? 1, 1))
  if (schema.type === 'string') {
    if (schema.format === 'base64') return picture
    if (schema.format === 'uuid') return crypto.randomUUID()
    if (schema.format === 'email') return 'player@example.test'
    if (schema.format === 'uri') return 'https://example.test/file.zip'
    if (schema.format === 'date-time') return new Date().toISOString()
    const length = schema.minLength ?? Number(/\{(\d+)\}/.exec(schema.pattern ?? '')?.[1] ?? 8)
    const choices = [
      samples[key],
      'a'.repeat(length),
      '26.2',
      'Steve',
      crypto.randomUUID(),
      '0'.repeat(length),
    ].filter(Boolean)
    const pattern = schema.pattern ? new RegExp(schema.pattern) : null
    return (
      choices.find(
        (value) =>
          value.length >= (schema.minLength ?? 0) &&
          value.length <= (schema.maxLength ?? Infinity) &&
          (!pattern || pattern.test(value)),
      ) ?? choices[0]
    )
  }
  return undefined
}
const writes = new Set([
  'servers.changeSettings',
  'servers.changeAuthentication',
  'servers.changeOtherVersions',
  'servers.changeBedrock',
  'servers.changeVersion',
  'servers.resize',
  'servers.rollback',
  'mods.change',
  'moderation.setTools',
])
function values(value) {
  if (value && typeof value === 'object') return Object.values(value).flatMap(values)
  return value === undefined ? [] : [value]
}
for (const path of paths)
  test(`the ${path} contract propagates its service refusal`, async () => {
    const procedure = appRouter._def.procedures[path]
    expect(procedure).toBeDefined()
    let input
    for (const schema of procedure._def.inputs ?? []) {
      const next = example(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }))
      input = next && typeof next === 'object' && !Array.isArray(next) ? { ...input, ...next } : next
    }
    for (const schema of procedure._def.inputs ?? []) {
      const valid = await schema.safeParseAsync(input)
      if (!valid.success) throw new Error(`${path}: ${JSON.stringify(valid.error.issues)}`)
    }
    const calls = []
    const owned = (parts = []) =>
      new Proxy(
        (...args) => {
          calls.push({ parts, args })
          throw new AppError('invalid_choice', message)
        },
        {
          get: (_target, key) => {
            const next = [...parts, key],
              name = next.join('.')
            if (name === 'accounts.isAdmin') return async () => true
            if (['realtime.url', 'realtime.fallbackUrl'].includes(name))
              return 'https://example.test/realtime'
            if (name === 'platform.capabilities') {
              calls.push({ parts: next })
              throw new AppError('invalid_choice', message)
            }
            return owned(next)
          },
        },
      )
    const services = owned()
    const caller = appRouter.createCaller({ actor, sessionId: crypto.randomUUID(), services, session: {} })
    const call = path.split('.').reduce((value, key) => value[key], caller)
    await expect(call(input)).rejects.toThrow(message)
    expect(calls.length).toBeGreaterThan(0)
    if (writes.has(path)) {
      const forwarded = values(calls[0].args)
      for (const key of ['serverId', 'requestId', 'version', 'when'])
        if (input[key] !== undefined) expect(forwarded).toContain(input[key])
    }
  })
