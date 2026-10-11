// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A real server’s life on production, end to end, timed (docs/production.md § From the command line):
 *
 *   bun scripts/production-check.ts [--owner <email>]
 *
 * As `operator:production-check`, through the operators' API (scripts/lib/production-reach.ts),
 * for one account (the first of ADMIN_EMAILS unless --owner names another): a server is made,
 * joined through the edge at its own address until it answers, stopped, rested in the archive
 * store with its Fly machine and volume let go, joined again and timed coming back from the
 * archive, then sent to the trash and purged, after which Fly holds no app of it. Whatever happens
 * on the way, the server it made goes to the trash and is purged before it exits.
 *
 * Production's control plane runs all the time, so every step is one of its own actions asked for
 * through the API, never a change to its database. Each server's Fly app is `bly-prod-` and its id
 * without dashes (apps/control/src/infra/fly/fly-runtime/apps.ts), read with flyctl on
 * production's own token. It uses the account's plan as it is: a Free account that already holds a
 * server has no room for this one, and `bun scripts/ops.ts --production limits` gives it some.
 */

import { randomUUID } from 'node:crypto'
import { resolve4 } from 'node:dns/promises'
import { authWorks } from './lib/auth-through-website.ts'
import { type Edge, join } from './lib/minecraft.ts'
import { flags, operatorCli } from './lib/operator-cli.ts'
import { productionFlyEnv, productionValues, reachProduction } from './lib/production-reach.ts'

const PLAY_DOMAIN = 'play.cubepals.com'
const FLY_ORG = 'blockly-prod'

const say = (line: string) => process.stdout.write(`${line}\n`)
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

process.env.OPERATOR = 'production-check'
const { options } = flags(process.argv.slice(2))
const { api } = operatorCli('production-check', '/ops/v1', 'docs/production.md', 'throw')

// ─── Steps ───────────────────────────────────────────────────────────────────────────────────

/** A step that failed: the run goes straight to cleaning up. */
class Stopped extends Error {}

const timings: string[] = []
let failed = 0

/** Runs one step against its time limit, and says how it went; a failure stops the run. */
async function step(name: string, limitSeconds: number, run: () => Promise<string>): Promise<void> {
  const began = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no end after ${limitSeconds}s`)), limitSeconds * 1000)
  })
  try {
    say(`  ok   ${name} — ${await Promise.race([run(), late])}  (${seconds(Date.now() - began)})`)
  } catch (error) {
    failed++
    say(`  FAIL ${name} — ${(error as Error).message}  (${seconds(Date.now() - began)})`)
    throw new Stopped(name)
  } finally {
    clearTimeout(timer)
  }
}
const must = (held: boolean, complaint: string) => {
  if (!held) throw new Error(complaint)
}
const timed = (what: string, ms: number) => {
  timings.push(`${what}: ${seconds(ms)}`)
  return seconds(ms)
}

// ─── Fly, on production's token ──────────────────────────────────────────────────────────────

function fly(args: string[]): unknown {
  const ran = Bun.spawnSync(['fly', ...args, '--json'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: productionFlyEnv(),
  })
  if (ran.exitCode !== 0)
    throw new Error(`fly ${args.slice(0, 2).join(' ')}: ${ran.stderr.toString().trim()}`)
  return JSON.parse(ran.stdout.toString() || '[]') ?? []
}
const appOf = (serverId: string) => `bly-prod-${serverId.replaceAll('-', '')}`
const appExists = (serverId: string) =>
  (fly(['apps', 'list', '-o', FLY_ORG]) as { Name: string }[]).some((app) => app.Name === appOf(serverId))
/** Machines and live volumes Fly holds for a server; none when its app is gone. */
function heldBy(serverId: string): string[] {
  if (!appExists(serverId)) return []
  const machines = fly(['machines', 'list', '-a', appOf(serverId)]) as { name: string; state: string }[]
  const volumes = (
    fly(['volumes', 'list', '-a', appOf(serverId)]) as { name: string; state: string }[]
  ).filter((volume) => volume.state !== 'destroyed' && volume.state !== 'pending_destroy')
  return [...machines, ...volumes].map((held) => `${held.name} ${held.state}`)
}

// ─── The server, through the operators' API ──────────────────────────────────────────────────

interface View {
  id: string
  name: string
  slug: string
  status: string
  activeOperation: { kind: string } | null
}
let server: View | null = null
const view = async () => (await api('GET', `/servers/${server?.id}`)) as View
async function until(want: (v: View) => boolean, what: string, limitSeconds: number): Promise<View> {
  const deadline = Date.now() + limitSeconds * 1000
  while (Date.now() < deadline) {
    const now = await view()
    if (want(now)) return now
    await Bun.sleep(3000)
  }
  throw new Error(`never ${what} within ${limitSeconds}s; it is ${(await view()).status}`)
}
const settledAs = (status: string, limitSeconds: number) =>
  until((v) => v.status === status && v.activeOperation === null, status, limitSeconds)

/** Where a player joining this address connects: the edge, as DNS answers for the name. */
async function edgeFor(address: string): Promise<Edge> {
  const [host] = await resolve4(address)
  if (!host) throw new Error(`${address} has no A record`)
  return { host, port: 25565 }
}
const address = () => `${server?.slug}.${PLAY_DOMAIN}`

// ─── The run ─────────────────────────────────────────────────────────────────────────────────

const started = Date.now()
try {
  await reachProduction()
} catch (error) {
  say(`production isn't reachable: ${(error as Error).message}`)
  process.exit(2)
}
const owner = options.get('owner')?.at(-1) ?? productionValues().ADMIN_EMAILS?.split(',')[0]?.trim()
if (!owner) {
  say('Name the account with --owner <email>: ADMIN_EMAILS is empty.')
  process.exit(2)
}
say(`production check, as operator:production-check, for ${owner}; players at <server>.${PLAY_DOMAIN}`)

try {
  say('\nthe website')
  await step('signs in and signs up through the website, every way', 60, () =>
    authWorks('https://cubepals.com'),
  )

  say('\nthe server')
  await step('is made for the account and comes up', 900, async () => {
    const at = Date.now()
    const name = `Production check ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
    server = (await api('POST', '/servers', { owner, name, idempotencyKey: randomUUID() })) as View
    const up = await until((v) => v.status !== 'provisioning', 'provisioned', 900)
    must(up.status === 'running' || up.status === 'stopped', `it is ${up.status}`)
    return `${server.name} (${server.id}) is ${up.status} after ${timed('made and first start', Date.now() - at)}`
  })

  await step('answers a player through the edge, at its own address', 600, async () => {
    const edge = await edgeFor(address())
    const took = await join(edge, address(), 'ProdCheck', 300_000)
    await until((v) => v.status === 'running', 'running', 300)
    return `${address()} on ${edge.host} answered in ${timed('join', took)}`
  })

  await step('stops when asked', 300, async () => {
    await api('POST', `/servers/${server?.id}/stop`)
    await settledAs('stopped', 300)
    return 'stopped, its world saved'
  })

  await step('rests in the archive store now, and lets go of its Fly machine and volume', 1200, async () => {
    const at = Date.now()
    await api('POST', `/servers/${server?.id}/rest`)
    await settledAs('stored', 1200)
    const took = timed('rest (snapshot, copy to the archive store, release)', Date.now() - at)
    const held = heldBy(server?.id ?? '')
    must(held.length === 0, `Fly still holds ${held.join(', ')}`)
    return `rested in ${took}; Fly holds no machine or volume of it`
  })

  await step('comes back from the archive when a player joins', 900, async () => {
    const edge = await edgeFor(address())
    const took = await join(edge, address(), 'ProdCheck', 900_000)
    const at = Date.now()
    await settledAs('running', 600)
    return `the player waited ${timed('wake from rest (new volume, copy restored, boot)', took)}, running ${seconds(Date.now() - at)} later`
  })
} catch (error) {
  if (!(error instanceof Stopped)) {
    failed++
    say(`  FAIL ${(error as Error).message}`)
  }
} finally {
  // Whatever happened, what this run made goes, and Fly is left holding none of it.
  if (server !== null) {
    say('\ncleaning up')
    await step('goes to the trash, and is purged now', 1200, async () => {
      // Whatever it was doing ends first: a server mid-start can't be sent to the trash.
      await until((v) => v.activeOperation === null, 'settled', 600)
      if ((await view()).status !== 'deleted') {
        await api('POST', `/servers/${server?.id}/trash`, { confirmName: server?.name })
        await settledAs('deleted', 600)
      }
      await api('POST', `/servers/${server?.id}/purge`, { confirmName: server?.name })
      await until((v) => v.status === 'purged', 'purged', 600)
      must(!appExists(server?.id ?? ''), `Fly still has ${appOf(server?.id ?? '')}`)
      return `purged; Fly holds no app ${appOf(server?.id ?? '')}`
    }).catch(() => {
      say(`  left behind: ${server?.id}, to trash and purge with bun scripts/ops.ts --production`)
    })
  }
}

say(`\n${timings.map((line) => `  ${line}`).join('\n')}`)
say(`\n${failed === 0 ? 'all good' : `${failed} failed`} in ${seconds(Date.now() - started)}`)
process.exit(failed === 0 ? 0 : 1)
