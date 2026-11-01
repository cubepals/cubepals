// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Successful mutations await their service write, then return the fresh owner view unchanged. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { OWN_ICON_SIZE } from '@blockly/contracts'
import { SECOND_MS } from '@blockly/contracts/durations'
import { PNG } from 'pngjs'
import { z } from 'zod'
import { hasDatabase, startHarness } from '../../testing/harness.ts'
import { appRouter } from './router.ts'

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

const writes = {
  'servers.create': 'servers.createMinecraftServer',
  'servers.start': 'servers.start',
  'servers.stop': 'servers.stop',
  'servers.restart': 'servers.restart',
  'servers.retry': 'servers.retry',
  'servers.undelete': 'servers.undeleteServer',
  'servers.saveIdentity': 'servers.saveIdentity',
  'servers.keep': 'servers.keep',
  'servers.keepWorld': 'servers.keepWorld',
  'servers.changeAddress': 'notices.changeAddress',
  'servers.changeSettings': 'revisions.changeSettings',
  'servers.changeAuthentication': 'revisions.changeAuthentication',
  'servers.changeOtherVersions': 'revisions.changeOtherVersions',
  'servers.changeBedrock': 'revisions.changeBedrock',
  'servers.changeVersion': 'mods.changeVersion',
  'servers.resize': 'revisions.resize',
  'servers.relocate': 'servers.relocate',
  'servers.settleWaiting': 'stopCheaters.waiting.settle',
  'servers.rollback': 'revisions.rollback',
  'backups.restore': 'backups.restoreBackup',
  'worlds.create': 'worlds.createWorld',
  'worlds.startOver': 'worlds.freshStart',
  'worlds.switch': 'worlds.switchWorld',
  'mods.change': 'mods.apply',
  'mods.changePack': 'packChanges.change',
  'moderation.setTools': 'moderation.setTools',
  'moderation.setStopCheaters': 'stopCheaters.set',
  'moderation.useOurStopCheaters': 'stopCheaters.useOurs',
}

function inputFor(path, id) {
  let input
  for (const schema of appRouter._def.procedures[path]._def.inputs ?? []) {
    const next = example(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }))
    input = next && typeof next === 'object' && !Array.isArray(next) ? { ...input, ...next } : next
  }
  if (input?.serverId) input.serverId = id
  return input
}
function values(value) {
  if (value && typeof value === 'object') return Object.values(value).flatMap(values)
  return value === undefined ? [] : [value]
}
async function written(calls) {
  const deadline = Date.now() + SECOND_MS
  while (calls.length === 0 && Date.now() < deadline) await Bun.sleep(1)
  expect(calls.length).toBe(1)
}

describe.skipIf(!hasDatabase)('the completed server mutation contract', () => {
  let h, owner, server, view
  beforeAll(async () => {
    h = await startHarness()
    owner = await h.user('Router owner', 'plus')
    const made = await h.create(owner)
    await h.until(made.id, 'running')
    await h.settled(made.id)
    server = await h.server(made.id)
    view = await h.app.queries.get(owner, made.id)
  }, 30 * SECOND_MS)
  afterAll(async () => {
    await h?.close()
  })

  for (const [path, write] of Object.entries(writes)) {
    test(
      `${path} waits for its write and returns the refreshed server`,
      async () => {
        const calls = []
        const gate = Promise.withResolvers()
        const services = (parts = []) =>
          new Proxy(() => {}, {
            get: (_target, key) => services([...parts, key]),
            apply: async (_target, _this, args) => {
              const name = parts.join('.')
              if (name === 'accounts.isAdmin') return h.app.accounts.isAdmin(...args)
              calls.push({ name, args })
              if (name === write) {
                await gate.promise
                return server
              }
              if (name === 'queries.get') return view
              throw new Error(`Unexpected service call: ${name}`)
            },
          })
        const caller = appRouter.createCaller({ actor: owner, services: services() })
        const input = inputFor(path, server.id)
        const call = path.split('.').reduce((value, key) => value[key], caller)
        const pending = call(input)
        try {
          await written(calls)
          expect(calls[0].name).toBe(write)
          expect(calls[0].args[0]).toBe(owner)
          const forwarded = values(calls[0].args)
          for (const key of ['serverId', 'requestId', 'version', 'when', 'settle'])
            if (input[key] !== undefined) expect(forwarded).toContain(input[key])
        } finally {
          gate.resolve()
        }
        expect(await pending).toBe(view)
        expect(calls.map((call) => call.name)).toEqual([write, 'queries.get'])
        expect(calls[1].args).toEqual([owner, server.id])
      },
      5 * SECOND_MS,
    )
  }
})
