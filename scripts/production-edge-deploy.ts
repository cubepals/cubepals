// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The flyctl calls that restart an edge app one region at a time (production-edge.ts decides the
 * order and the waits): the image built once, then each region's machine cordoned, drained of
 * players through the edge's own count (`/_health/drain`, apps/edge/browser-redirect.ts), given
 * the image and waited on. Not for placing machines, which is production.ts's.
 */
import { spawn, spawnSync } from 'node:child_process'
import { type Clock, type RegionSteps, rollEdge } from './production-edge.ts'

/** A Fly machine, as `fly machines list --json` lists it. */
interface Machine {
  id: string
  region: string
  state: string
}

/** Where the agent's HTTP service listens on the machine (infra/fly/edge.toml). */
const AGENT_HTTP_PORT = 8080

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
async function drainState(app: string, machine: Machine, env: NodeJS.ProcessEnv) {
  const target = `${machine.id}.vm.${app}.internal`
  const proxy = spawn('fly', ['proxy', `${PROXY_PORT}:${AGENT_HTTP_PORT}`, target, '--app', app], {
    env,
    stdio: 'ignore',
  })
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const answer = await fetch(`http://127.0.0.1:${PROXY_PORT}/_health/drain`, {
          signal: AbortSignal.timeout(5_000),
          redirect: 'manual',
        })
        // An edge from before it counted its players redirects a path it doesn't know, as it does
        // a browser; the first roll onto this one.
        if (answer.status === 404 || (answer.status >= 300 && answer.status < 400)) return null
        if (answer.ok) return (await answer.json()) as { players: number; routesCurrent: boolean }
        throw new Error(`answered ${answer.status}`)
      } catch (error) {
        if (attempt >= 5) throw error
        await clock.sleep(1_000)
      }
    }
  } finally {
    proxy.kill()
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
): Promise<number> {
  const machineIn = (region: string): Machine => {
    const machine = machinesOf(app, env).find((m) => m.region === region)
    if (machine === undefined) throw new Error(`The edge has no machine in ${region}`)
    return machine
  }
  const fly = (...args: string[]) => {
    const result = spawnSync('fly', args, { stdio: 'inherit', env })
    if (result.status !== 0)
      throw new Error(`fly ${args[0]} ${args[1] ?? ''} stopped (exit ${result.status})`)
  }
  const steps: RegionSteps = {
    cordon: async (region) => fly('machine', 'cordon', machineIn(region).id, '--app', app),
    players: async (region) => {
      const state = await drainState(app, machineIn(region), env)
      if (state === null) say(`${region}: this edge doesn’t count its players yet, so none is waited for`)
      return state?.players ?? 0
    },
    othersReady: async (region) => {
      const others = machinesOf(app, env).filter((m) => m.region !== region)
      for (const other of others) if ((await drainState(app, other, env))?.routesCurrent === true) return true
      return false
    },
    uncordon: async (region) => fly('machine', 'uncordon', machineIn(region).id, '--app', app),
    deploy: async (region) =>
      fly(
        'deploy',
        '--image',
        image,
        '--config',
        config,
        '--app',
        app,
        '--regions',
        region,
        '--update-only',
        '--yes',
        '--ha=false',
      ),
    ready: async (region) => (await drainState(app, machineIn(region), env))?.routesCurrent === true,
  }
  return rollEdge(regions, steps, say, clock)
}
