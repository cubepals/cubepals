// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The load test's probes, as the test drives them from outside Fly: an app of their own in
 * `blockly-staging`, as many machines as its headless players need cores, each running
 * `load-probe.ts`, and a `fly proxy` to each so the test can hand it jobs. The first one also
 * forwards staging's database, which the session can't reach directly.
 *
 * Not for: what a job does (`load-probe.ts`), or what the test does with the answers (`load-player.ts`).
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORG = 'blockly-staging'
const REGION = 'fra'
/** Headless players a probe holds at once: mineflayer keeps each one's world in memory. */
export const PLAYERS_PER_PROBE = 20
/** Each probe's machine: two cores of its own, and room for its players' worlds. */
const PROBE_GUEST = ['--vm-cpu-kind', 'performance', '--vm-cpus', '2', '--vm-memory', '8192']
/** The first local port a probe's tunnel takes; the database's comes from its own. */
const FIRST_PORT = 18100
export const DATABASE_PORT = 15432

/** flyctl, without holding up the players while it answers. */
export async function fly(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(['fly', ...args], {
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`fly ${args.slice(0, 3).join(' ')}: ${err.trim()}`)
  return out
}

/** `fly proxy` from a local port, for as long as this runs. */
export function tunnel(local: number, remote: number, app: string, host?: string): void {
  const child = spawn('fly', ['proxy', `${local}:${remote}`, ...(host ? [host] : []), '-a', app], {
    stdio: 'ignore',
  })
  process.on('exit', () => child.kill())
}

/** The bundle a probe runs. */
async function bundle(): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), 'load-probe-'))
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'load-probe.ts')],
    target: 'bun',
    outdir: out,
    naming: 'probe.js',
  })
  if (!built.success) throw new AggregateError(built.logs, 'the probe did not build')
  return join(out, 'probe.js')
}

/** What a job found, or why it failed, with every join attempt it made. */
export interface JobAnswer {
  done: boolean
  // biome-ignore lint/suspicious/noExplicitAny: each job kind answers its own shape, read loosely
  result?: any
  error?: string
  attempts?: { ms: number; ended: string | null }[]
}

export class Probe {
  readonly id: string
  readonly port: number
  /** Jobs handed to it and not done: where the next player goes is the probe with the fewest. */
  active = 0
  /** Requests sent again after the tunnel to it dropped them: the test's own, never the product's. */
  static resent = 0
  constructor(id: string, port: number) {
    this.id = id
    this.port = port
  }

  /** A request through the tunnel; one the tunnel drops is sent again, which a named job allows. */
  async #call(path: string, body?: unknown, tries = 5): Promise<unknown> {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        method: body === undefined ? 'GET' : 'PUT',
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      })
      if (!response.ok) throw new Error(`probe ${this.id} ${path}: ${response.status}`)
      return await response.json()
    } catch (error) {
      if (tries <= 1 || (error as Error).message.startsWith(`probe ${this.id}`)) throw error
      Probe.resent++
      await Bun.sleep(2000)
      return this.#call(path, body, tries - 1)
    }
  }

  /** A job handed to the probe, and its answer once it is done. */
  async run(job: Record<string, unknown>, pollMs = 3000): Promise<JobAnswer> {
    const id = randomUUID()
    this.active++
    try {
      await this.#call(`/jobs/${id}`, job)
      for (;;) {
        await Bun.sleep(pollMs)
        const answer = (await this.#call(`/jobs/${id}`).catch(() => ({ done: false }))) as JobAnswer
        if (answer.done) return answer
      }
    } finally {
      this.active--
    }
  }

  versions(): Promise<string[]> {
    return this.#call('/versions') as Promise<string[]>
  }

  load(): Promise<{ load: number; players: number }> {
    return this.#call('/load') as Promise<{ load: number; players: number }>
  }
}

/** The probe with the fewest jobs on it now. */
export const leastBusy = (probes: readonly Probe[]): Probe => {
  const [first, ...rest] = probes
  if (first === undefined) throw new Error('no probes')
  return rest.reduce((best, probe) => (probe.active < best.active ? probe : best), first)
}

/** The probes' app and machines, each running the probe, and a tunnel to each. */
export async function probesUp(app: string, count: number, databaseHost: string): Promise<Probe[]> {
  await fly(['apps', 'create', app, '-o', ORG])
  await fly(['secrets', 'import', '--stage', '-a', app], `DATABASE_HOST=${databaseHost}\n`)
  const file = await bundle()
  const ids = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const out = await fly([
        'machine',
        'run',
        'oven/bun:1.4.3-slim',
        ...['-a', app, '-r', REGION, '--name', `probe-${i}`, ...PROBE_GUEST, '--restart', 'no'],
        ...['--file-local', `/load/probe.js=${file}`],
        ...['--entrypoint', 'sh', '--', '-c'],
        'cd /load && bun add mineflayer@4.39.0 minecraft-data@3.117.0 vec3@0.1.10 && exec bun probe.js serve',
      ])
      const id = /Machine ID: (\w+)/.exec(out)?.[1]
      if (id === undefined) throw new Error(`no machine id in: ${out.slice(0, 200)}`)
      return id
    }),
  )
  const probes = ids.map((id, i) => {
    tunnel(FIRST_PORT + i, 8080, app, `${id}.vm.${app}.internal`)
    return new Probe(id, FIRST_PORT + i)
  })
  const [first] = ids
  if (first !== undefined) tunnel(DATABASE_PORT, 5432, app, `${first}.vm.${app}.internal`)
  // Each answers once mineflayer is installed and it serves.
  for (const probe of probes)
    for (let tries = 0; ; tries++) {
      if (
        await probe.load().then(
          () => true,
          () => false,
        )
      )
        break
      if (tries > 120) throw new Error(`probe ${probe.id} never answered`)
      await Bun.sleep(2000)
    }
  return probes
}

/** The probes' app, machines and all. */
export async function probesDown(app: string): Promise<void> {
  await fly(['apps', 'destroy', app, '--yes'])
}
