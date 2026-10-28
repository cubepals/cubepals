// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sizes the edge for Bedrock players by measuring it, on temporary apps in `blockly-staging`:
 *
 *   bun tools/bedrock-join/size/size.ts up <n> <size> [memory-mb]
 *        bly-bedrock-size-<n>: this checkout's edge with Geyser, with Xbox sign-in off (its clients
 *        have no Xbox account), and bly-bedrock-size-<n>-load: a Java server, a stand-in control
 *        plane for the edge, and two client machines running the join tool
 *   bun tools/bedrock-join/size/size.ts resize <n> <size> [memory-mb]
 *   bun tools/bedrock-join/size/size.ts run <n> <bedrock players: 0|10|20> <seconds>
 *        that many Bedrock players (half from each client machine) and five loops of Java
 *        joins, for `seconds`; prints the edge's memory and CPU by process, and the join times
 *   bun tools/bedrock-join/size/size.ts down <n>   destroys both apps
 *
 * Needs flyctl with a token for the org. Never touches any other app.
 */

import { randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORG = 'blockly-staging'
const REGION = 'fra'
const HERE = import.meta.dir
const ROOT = join(HERE, '../../..')

function fly(args: string[], input?: string): string {
  const run = Bun.spawnSync(['fly', ...args], {
    cwd: ROOT,
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
  })
  const out = `${run.stdout}${run.stderr}`
  if (run.exitCode !== 0) throw new Error(`fly ${args.join(' ')}: ${out.slice(-1500)}`)
  return out
}

/**
 * What the two images copy, in a folder of its own to build from: the repository's .dockerignore
 * leaves out tools/, where the load machines' files are.
 */
function stage(dir: string): string {
  const context = join(dir, 'context')
  rmSync(context, { recursive: true, force: true })
  for (const path of [
    'apps/edge',
    'packages/contracts/src',
    'apps/control/src/minecraft/ports.ts',
    'tools/bedrock-join/package.json',
    'tools/bedrock-join/bun.lock',
    'tools/bedrock-join/join.ts',
    'tools/bedrock-join/size',
    'scripts/lib/minecraft.ts',
  ])
    cpSync(join(ROOT, path), join(context, path), { recursive: true })
  return context
}

function deploy(app: string, context: string, config: string, dockerfile: string): void {
  const run = Bun.spawnSync(
    [
      'fly',
      'deploy',
      context,
      '--config',
      config,
      '--dockerfile',
      dockerfile,
      '--app',
      app,
      '--remote-only',
      '--depot=false',
      '--ha=false',
      '--yes',
      ...(app.endsWith('-load') ? ['--no-public-ips'] : []),
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  if (run.exitCode !== 0) throw new Error(`deploying ${app} failed`)
}

const names = (n: string) => ({ edge: `bly-bedrock-size-${n}`, load: `bly-bedrock-size-${n}-load` })

interface Machine {
  id: string
  name: string
  state: string
  config: { image: string }
}
const machines = (app: string): Machine[] => JSON.parse(fly(['machines', 'list', '-a', app, '--json']))

function tempDir(n: string): string {
  const dir = join(tmpdir(), `bedrock-size-${n}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function up(n: string, size: string, memory: string) {
  const { edge, load } = names(n)
  const dir = tempDir(n)
  const context = stage(dir)
  const existing = fly(['apps', 'list', '--org', ORG, '--json'])
  for (const app of [load, edge])
    if (!existing.includes(`"${app}"`)) fly(['apps', 'create', app, '--org', ORG])
  const loadToml = join(dir, 'load.toml')
  writeFileSync(
    loadToml,
    `app = "${load}"\nprimary_region = "${REGION}"\n\n[[vm]]\n  size = "shared-cpu-2x"\n  memory = "2048mb"\n`,
  )
  if (machines(load).length === 0)
    deploy(load, context, loadToml, join(context, 'tools/bedrock-join/size/load/Dockerfile'))
  const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT }).stdout.toString().trim()
  // The pushed commit is fetched on a machine and run from source: a test edge has no image of
  // its own, and the load machines' image is older than the commit.
  const start = (script: string) =>
    `mkdir -p /edge/repo && cd /edge && bun -e 'await Bun.write("repo.tgz", await fetch("https://codeload.github.com/cubepals/cubepals/tar.gz/" + process.env.COMMIT))' && tar xzf repo.tgz -C repo --strip-components=1 && exec sh repo/tools/bedrock-join/size/${script}`
  const image = machines(load).find((m) => m.name === 'client-a')?.config.image
  if (image === undefined) throw new Error('the load app has no client machine')
  for (const old of machines(load).filter((m) => !['client-a', 'client-b', 'server'].includes(m.name)))
    fly(['machine', 'destroy', old.id, '-a', load, '--force'])
  if (!machines(load).some((m) => m.name === 'server'))
    fly([
      'machine',
      'run',
      image,
      '-a',
      load,
      '--name',
      'server',
      '--region',
      REGION,
      '--vm-size',
      'shared-cpu-2x',
      '--vm-memory',
      '2048',
      '--autostop=off',
      '--env',
      `COMMIT=${commit}`,
      '--entrypoint',
      '/bin/sh',
      '--',
      '-c',
      start('load/start.sh server'),
    ])
  const server = machines(load).find((m) => m.name === 'server')
  if (server === undefined) throw new Error('the server machine did not start')
  for (const old of machines(edge)) fly(['machine', 'destroy', old.id, '-a', edge, '--force'])
  fly(['ips', 'allocate-v4', '--shared', '-a', edge, '-y'])
  const environment = {
    COMMIT: commit,
    MC_ROUTER_VERSION:
      /mc-router:(\d+\.\d+\.\d+)/.exec(readFileSync(join(ROOT, 'apps/edge/Dockerfile'), 'utf8'))?.[1] ?? '',
    CONTROL_URL: `http://${server.id}.vm.${load}.internal:4001`,
    EDGE_TOKEN: randomBytes(12).toString('hex'),
    FLOODGATE_KEY: randomBytes(16).toString('base64'),
    PROXY_PROTOCOL: '1',
    BEDROCK_VALIDATE_LOGIN: 'false',
    GEYSER_HEAP: Number(memory) >= 2048 ? '768m' : '512m',
    BEDROCK_OPENS_PER_SECOND: '1000',
    BEDROCK_OPENS_BURST: '1000',
    BEDROCK_ADDRESS_PLAYERS: '1000',
    BEDROCK_PONGS_PER_SECOND: '1000',
    BEDROCK_PONGS_BURST: '1000',
    BEDROCK_TOTAL_PONGS_PER_SECOND: '1000',
    BEDROCK_TOTAL_PONGS_BURST: '1000',
    ADDRESS_CONNECTIONS_PER_SECOND: '1000',
    ADDRESS_CONNECTIONS_BURST: '1000',
    ADDRESS_GREETING: '1000',
    ADDRESS_OPEN_CONNECTIONS: '1000',
  }
  fly([
    'machine',
    'run',
    server.config.image,
    '-a',
    edge,
    '--name',
    'edge',
    '--region',
    REGION,
    '--vm-size',
    size,
    '--vm-memory',
    memory,
    '--autostop=off',
    '--port',
    '25565:25565/tcp:proxy_proto',
    '--port',
    '19132:19132/udp',
    ...Object.entries(environment).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    '--entrypoint',
    '/bin/sh',
    '--',
    '-c',
    start('edge/boot.sh'),
  ])
  process.stdout.write(`up: ${edge} (${size} ${memory} MB), load app ${load}\n`)
}

function resize(n: string, size: string, memory: string) {
  const { edge } = names(n)
  const machine = machines(edge)[0]
  if (machine === undefined) throw new Error('run `up` first')
  fly(['machine', 'update', machine.id, '-a', edge, '--vm-size', size, '--vm-memory', memory, '--yes'])
  process.stdout.write(`resized ${edge} to ${size} ${memory} MB\n`)
}

const exec = (app: string, id: string, command: string, timeout = 600) =>
  fly(['machine', 'exec', id, command, '-a', app, '--timeout', String(timeout)])

interface Sample {
  at: number
  processes: Record<string, { rssKb: number; cpuTicks: number }>
  machine: {
    user: number
    system: number
    idle: number
    steal: number
    memAvailableKb: number
    memTotalKb: number
  }
}

/** What the samples taken between two moments say: CPU as a share of one core, memory at its highest. */
function summarize(samples: Sample[], ticksPerSecond = 100) {
  const first = samples[0]
  const last = samples.at(-1)
  if (first === undefined || last === undefined || last.at === first.at) return null
  const seconds = (last.at - first.at) / 1000
  const out: Record<string, { rssMbMax: number; cpuPercentOfOneCore: number }> = {}
  for (const name of Object.keys(last.processes)) {
    const cpu = (last.processes[name]?.cpuTicks ?? 0) - (first.processes[name]?.cpuTicks ?? 0)
    out[name] = {
      rssMbMax: Math.round(Math.max(...samples.map((s) => s.processes[name]?.rssKb ?? 0)) / 1024),
      cpuPercentOfOneCore: Math.round((cpu / ticksPerSecond / seconds) * 1000) / 10,
    }
  }
  const busy = last.machine.user + last.machine.system - first.machine.user - first.machine.system
  const steal = last.machine.steal - first.machine.steal
  return {
    seconds: Math.round(seconds),
    processes: out,
    machineBusyPercentOfOneCore: Math.round((busy / ticksPerSecond / seconds) * 1000) / 10,
    machineStealPercentOfOneCore: Math.round((steal / ticksPerSecond / seconds) * 1000) / 10,
    machineMemoryUsedMbMax: Math.round(
      Math.max(...samples.map((s) => s.machine.memTotalKb - s.machine.memAvailableKb)) / 1024,
    ),
  }
}

/** Starts `command` on a machine and leaves it running: an exec that lasts a minute is cut off. */
function detach(app: string, id: string, command: string, log: string): void {
  exec(app, id, `sh -c 'rm -f ${log}; nohup ${command} > ${log} 2>&1 &'`, 60)
}

/** Waits for a detached command to print its last line, a JSON object; returns it. */
async function finished(app: string, id: string, log: string, seconds: number): Promise<string> {
  for (let waited = 0; waited < seconds; waited += 5) {
    await Bun.sleep(5000)
    const last = exec(app, id, `tail -n 1 ${log}`, 60).trim().split('\n').pop() ?? ''
    if (last.startsWith('{')) return last
  }
  return 'no answer'
}

async function run(n: string, players: number, seconds: number) {
  const { edge, load } = names(n)
  const edgeMachine = machines(edge)[0]
  const clients = machines(load).filter((m) => m.name.startsWith('client'))
  if (edgeMachine === undefined || clients.length < 2) throw new Error('run `up` first')
  const [a, b] = clients as [Machine, Machine]
  const relay = `${edgeMachine.id}.vm.${edge}.internal:19140`
  const tool = '/app/tools/bedrock-join'
  const joinCommand = (offset: number, count: number) =>
    `bun ${tool}/join.ts --address a.play.bsize --via6 ${relay} --players ${count} --offset ${offset} --stagger 1500 --hold ${seconds} --timeout 180`
  if (players > 0) {
    detach(load, a.id, joinCommand(0, players / 2), '/tmp/bedrock.log')
    detach(load, b.id, joinCommand(100, players / 2), '/tmp/bedrock.log')
  }
  // The Java loops start once the Bedrock players are in.
  const settle = players > 0 ? Math.ceil((players * 1.5) / 2) + 25 : 0
  await Bun.sleep(settle * 1000)
  const measuredFrom = Date.now()
  const javaFor = Math.max(30, seconds)
  detach(load, a.id, `bun ${tool}/size/load/java-load.ts ${edge}.fly.dev 5 ${javaFor}`, '/tmp/java.log')
  const java = await finished(load, a.id, '/tmp/java.log', javaFor + 120)
  const bedrock =
    players > 0
      ? [
          await finished(load, a.id, '/tmp/bedrock.log', seconds + 300),
          await finished(load, b.id, '/tmp/bedrock.log', 60),
        ]
      : []
  const stats = JSON.parse(
    exec(
      load,
      a.id,
      `bun -e "process.stdout.write(await (await fetch('http://${edgeMachine.id}.vm.${edge}.internal:8099/stats?since=${measuredFrom}')).text())"`,
      60,
    ),
  ) as Sample[]
  process.stdout.write(
    `${JSON.stringify({ bedrockPlayers: players, java: JSON.parse(java.startsWith('{') ? java : '{}'), bedrock: bedrock.map((r) => (r.startsWith('{') ? JSON.parse(r) : r)), edge: summarize(stats) }, null, 2)}\n`,
  )
}

function down(n: string) {
  const { edge, load } = names(n)
  for (const app of [edge, load]) fly(['apps', 'destroy', app, '--yes'])
  process.stdout.write(`destroyed ${edge} and ${load}\n`)
}

const [command, n = '1', a = '', b = ''] = process.argv.slice(2)
if (command === 'up') await up(n, a, b || '1024')
else if (command === 'resize') resize(n, a, b || '1024')
else if (command === 'run') await run(n, Number(a), Number(b))
else if (command === 'down') down(n)
else {
  process.stderr.write('usage: size.ts up|resize|run|down <n> …\n')
  process.exit(2)
}
