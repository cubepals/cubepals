// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether a server's Java runs as its spec says, read on its machine: the child of the image's
 * runner (`mc-server-runner`, which gives it the console and sends `stop` at a stop), with the heap
 * the spec gives it (`MAX_MEMORY`, which the image passes as `-Xmx`). A start that runs Java some
 * other way still answers the ping, logins and RCON, so nothing else the staging check reads tells
 * it apart: #559's Paperclip check on Alpine ran Mojang's jar as a patch run, with Java's default
 * heap, under no runner. Not a check of the start scripts' lines, which their own tests hold.
 */

import { fly } from './fly-async.ts'

/**
 * Every process whose command line names Java or the runner, with its arguments. `fly machine exec`
 * runs no shell and splits its command on spaces, so the `|` reaches pgrep as its own alternation.
 */
const LISTED = 'pgrep -a -f java|mc-server-runner'

/** A process as pgrep lists it. */
type Listed = { pid: string; args: string }

/** The processes in pgrep's listing; flyctl's own lines (`Exit code: 1`) aren't any. */
function listedIn(text: string): Listed[] {
  return text
    .split('\n')
    .map((line) => line.match(/^(\d+) (.+)$/))
    .filter((found) => found !== null)
    .map(([, pid = '', args = '']) => ({ pid, args }))
}

/** The runner, by its command line, and not a shell whose arguments name it. */
export function runnerIn(listing: string): Listed | undefined {
  return listedIn(listing).find((p) => p.args.startsWith('mc-server-runner '))
}

/**
 * What is wrong with the Java on a machine, or null: `listing` is pgrep's (`LISTED`), `children` the
 * runner's children's pids, one to a line, and `heap` the spec's `MAX_MEMORY`.
 */
export function javaWrong(listing: string, children: string, heap: string): string | null {
  const javas = listedIn(listing).filter((p) => p.args.startsWith('java '))
  const seen = javas.map((p) => p.args.slice(0, 120)).join(' | ') || 'none'
  if (runnerIn(listing) === undefined) return `no mc-server-runner on the machine; its Java: ${seen}`
  const own = new Set(children.split('\n').filter((line) => /^\d+$/.test(line)))
  const run = javas.filter((p) => own.has(p.pid))
  if (run.length !== 1) return `mc-server-runner runs ${run.length} Java; the machine's: ${seen}`
  if (!` ${run[0]?.args} `.includes(` -Xmx${heap} `)) return `its Java runs without -Xmx${heap}: ${seen}`
  return null
}

/**
 * The verdict on the started machine of a server's Fly app, read with two `fly machine exec`s, about
 * a second each; throws what is wrong.
 */
export async function javaOnMachine(app: string): Promise<string> {
  const machines = JSON.parse((await fly(['machines', 'list', '-a', app, '--json'])) || '[]') as {
    id: string
    state: string
    config?: { env?: Record<string, string> }
  }[]
  const machine = machines.find((m) => m.state === 'started')
  const heap = machine?.config?.env?.MAX_MEMORY ?? ''
  if (machine === undefined || heap === '') throw new Error(`no started machine with a heap in ${app}`)
  const exec = (command: string) => fly(['machine', 'exec', machine.id, command, '-a', app])
  const listing = await exec(LISTED)
  const runner = runnerIn(listing)
  const wrong = javaWrong(listing, runner === undefined ? '' : await exec(`pgrep -P ${runner.pid}`), heap)
  if (wrong !== null) throw new Error(wrong)
  return `Java under mc-server-runner with -Xmx${heap}`
}
