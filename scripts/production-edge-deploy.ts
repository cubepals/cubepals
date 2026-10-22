// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The flyctl calls that restart an edge app one region at a time (production-edge.ts decides the
 * order and the waits): the image built once, then each region's machine cordoned, drained of
 * players through the edge's own count (`/`, apps/edge/browser-redirect.ts), given
 * the image and waited on. Not for placing machines, which is production.ts's.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  type Clock,
  deployMachines,
  type Machine,
  machinesIn,
  type RegionSteps,
  rollEdge,
  sumPlayers,
} from './production-edge.ts'

/** Where the agent answers a deploy, on the private network only (apps/edge/drain.ts). */
const DRAIN_PORT = 8091

/** The local port `fly proxy` listens on, for the machine being asked. */
const PROXY_PORT = 18080

const clock: Clock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }

/** The app's machines, one in each region it runs in; none for an app never deployed. */
export function machinesOf(app: string, env: NodeJS.ProcessEnv): Machine[] {
  const listed = spawnSync('fly', ['machines', 'list', '--app', app, '--json'], { encoding: 'utf8', env })
  if (listed.status !== 0) throw new Error(`fly machines list stopped (exit ${listed.status})`)
  return JSON.parse(listed.stdout || '[]') as Machine[]
}

/** Asks one machine's agent what a deploy waits on, through a proxy that lives for the call. */
async function drainState(app: string, id: string, env: NodeJS.ProcessEnv) {
  const target = `${id}.vm.${app}.internal`
  const proxy = spawn('fly', ['proxy', `${PROXY_PORT}:${DRAIN_PORT}`, target, '--app', app], {
    env,
    stdio: 'ignore',
  })
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const answer = await fetch(`http://127.0.0.1:${PROXY_PORT}/`, {
          signal: AbortSignal.timeout(5_000),
          redirect: 'manual',
        })
        if (answer.ok) return (await answer.json()) as { players: number; routesCurrent: boolean }
        throw new Error(`answered ${answer.status}`)
      } catch (error) {
        if (attempt >= 15) throw error
        await clock.sleep(1_000)
      }
    }
  } finally {
    // Gone before the next question reuses the port.
    const exited = new Promise((resolve) => proxy.once('exit', resolve))
    proxy.kill()
    await exited
  }
}

/**
 * The app's image, built from this checkout and pushed with `label`, and the reference machines
 * are given. Nothing is restarted by it.
 */
export function buildEdgeImage(
  app: string,
  config: string,
  dockerfile: string,
  label: string,
  env: NodeJS.ProcessEnv,
): string {
  const args = ['deploy', '.', '--build-only', '--push', '--remote-only', '--dockerfile', dockerfile].concat([
    '--image-label',
    label,
    '--config',
    config,
    '--app',
    app,
  ])
  let built = spawnSync('fly', args, { stdio: 'inherit', env })
  // Depot's builders speak gRPC over TLS, which an intercepting proxy breaks; Fly's own come in over WireGuard.
  if (built.status !== 0) built = spawnSync('fly', [...args, '--depot=false'], { stdio: 'inherit', env })
  if (built.status !== 0) throw new Error(`fly deploy --build-only stopped (exit ${built.status})`)
  return `registry.fly.io/${app}:${label}`
}

/**
 * Puts `image` on the app's machines one region at a time, in the order of `regions`; how many
 * players were cut. A machine each region, as the edge runs (production-edge.ts).
 */
export async function rollEdgeApp(
  app: string,
  config: string,
  image: string,
  regions: readonly string[],
  env: NodeJS.ProcessEnv,
  say: (line: string) => void,
): Promise<{ cut: number; uncounted: string[] }> {
  const idsIn = (region: string): string[] => {
    const ids = machinesIn(machinesOf(app, env), region)
    if (ids.length === 0) throw new Error(`The edge has no machine in ${region}`)
    return ids
  }
  const fly = (...args: string[]) => {
    const result = spawnSync('fly', args, { stdio: 'inherit', env })
    if (result.status !== 0)
      throw new Error(`fly ${args[0]} ${args[1] ?? ''} stopped (exit ${result.status})`)
  }
  const stateOf = (id: string) => drainState(app, id, env).catch(() => null)
  const steps: RegionSteps = {
    cordon: async (region) => fly('machine', 'cordon', ...idsIn(region), '--app', app),
    othersReady: async (region) => {
      const others = machinesOf(app, env).filter((m) => m.region !== region)
      for (const other of new Set(others.map((m) => m.region))) {
        const states = []
        for (const id of machinesIn(others, other)) states.push(await stateOf(id))
        if (states.every((s) => s?.routesCurrent === true)) return true
      }
      return false
    },
    uncordon: async (region) => fly('machine', 'uncordon', ...idsIn(region), '--app', app),
    players: async (region) => {
      // An edge from before it counted its players has nothing listening; that and a proxy that
      // can't reach the edge both read as an edge that can't say.
      const counts = []
      for (const id of idsIn(region)) counts.push((await stateOf(id))?.players ?? null)
      return sumPlayers(counts)
    },
    deploy: async (region) => fly(...deployMachines(app, config, image, idsIn(region))),
    ready: async (region) => {
      for (const id of idsIn(region)) if ((await stateOf(id))?.routesCurrent !== true) return false
      return true
    },
  }
  return rollEdge(regions, steps, say, clock, { cordon: process.env.EDGE_CORDON === '1' })
}
