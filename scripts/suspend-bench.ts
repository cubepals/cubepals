// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a sleeping server wakes from Fly's suspend against a cold start, measured on temporary apps in
 * `blockly-staging`: on machines of its own, and, through
 * the edge, on a Cubepals server of staging's that its control plane put to sleep.
 *
 *   bun scripts/suspend-bench.ts config <paper|skyblock> <2g|3g>   the machine config, as JSON
 *   bun scripts/suspend-bench.ts probe                             both apps, and the probe's machine
 *   bun scripts/suspend-bench.ts up <paper|skyblock> <2g|3g> [tag] a Minecraft machine of it, made
 *   bun scripts/suspend-bench.ts run <job> <machine name> [count]  a probe job, in the background
 *   bun scripts/suspend-bench.ts join <hostname> [per second]      a player joining it, the same way
 *   bun scripts/suspend-bench.ts flow <template> <size> [cycles]   Cubepals' own sleep and wake, timed
 *   bun scripts/suspend-bench.ts results                           what the probe's jobs printed
 *   bun scripts/suspend-bench.ts push                              the probe's code, again
 *   bun scripts/suspend-bench.ts down                              both apps destroyed
 *
 * The Minecraft machines' configs are Cubepals' own: `toRuntimeSpec` for a new Free server of the
 * template, made a Fly machine by `machineConfig`, as `FlyRuntime` makes one. Three things differ,
 * all so a headless player can join: account checks are off (an owner's setting), the version is
 * 1.21.11, the newest mineflayer speaks (the plain Paper template would pick 26.2), and Paper reads
 * no PROXY header, since the players join it directly rather than through the edge. All of them
 * live in one app, `bly-suspend-bench-mc`. The probe (`lib/suspend-probe.ts`, bundled with this
 * checkout's control-plane code and run by bun) runs in an app of its own, `bly-suspend-bench-probe`,
 * since the game port can't be reached from here, and every time it reports is from its own clock.
 * A machine's `/.fly/api` socket acts only on that machine (403 for its neighbours, 2026-10-11), so
 * the probe holds a token. `flow` makes an app of its own per run (`bly-sbench-…`), which the
 * probe destroys when it is done; `down` destroys any left.
 *
 * Templates: `paper` (Smooth), `skyblock`, `fabric` and `neoforge`, each on VERSION.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loaderPin } from '../apps/control/src/app/revisions/pins.ts'
import { templateOf } from '../apps/control/src/app/setups/templates.ts'
import type { PinnedMod } from '../apps/control/src/domain/mods/artifact.ts'
import { defaultSettings, type ServerRevision } from '../apps/control/src/domain/revision/revision.ts'
import type { MemoryTier } from '../apps/control/src/domain/server/size.ts'
import { machineConfig } from '../apps/control/src/infra/fly/machine-config.ts'
import { UpstreamLoaderBuilds } from '../apps/control/src/infra/loaders/loader-builds.ts'
import { PROXY_ENV, toRuntimeSpec } from '../apps/control/src/minecraft/runtime-spec.ts'

const ORG = 'blockly-staging'
const MC_APP = 'bly-suspend-bench-mc'
const PROBE_APP = 'bly-suspend-bench-probe'
const REGION = 'fra'
const VERSION = '1.21.11'
/** Paper's newest stable build of 1.21.11 on 2026-10-11. */
const PAPER_BUILD = '132'
const SERVER_ID = 'suspend-bench'

export const say = (line: string): void => void process.stdout.write(`${line}\n`)

/** flyctl, its output returned; it stops the bench when flyctl fails. */
export function fly(args: string[], input?: string): string {
  const run = Bun.spawnSync(['fly', ...args], {
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) throw new Error(`fly ${args[0]} ${args[1] ?? ''}: ${run.stderr.toString().trim()}`)
  return run.stdout.toString()
}

/** A plugin pinned as Hangar serves it for Paper on VERSION today: its newest version. */
async function pinnedOnHangar(projectId: string): Promise<PinnedMod> {
  const id = projectId.replace(/^hangar:/, '')
  const query = `platform=PAPER&platformVersion=${VERSION}&limit=1`
  const response = await fetch(`https://hangar.papermc.io/api/v1/projects/${id}/versions?${query}`)
  const [version] = ((await response.json()) as { result: HangarVersion[] }).result
  const file = version?.downloads.PAPER
  if (version === undefined || file?.downloadUrl == null)
    throw new Error(`${projectId} has nothing for ${VERSION}`)
  return {
    source: { catalog: 'hangar', projectId, versionId: String(version.id) },
    name: version.name,
    versionLabel: version.name,
    artifact: {
      ref: { kind: 'remote', url: file.downloadUrl },
      // Hangar publishes a sha256; nothing on the bench checks a hash.
      sha512: file.fileInfo.sha256Hash,
      sizeBytes: file.fileInfo.sizeBytes,
      fileName: file.fileInfo.name,
    },
    environment: 'server',
    loaders: ['paper'],
    gameVersions: [VERSION],
    origin: 'user',
    requiredBy: [],
  }
}
interface HangarVersion {
  id: number
  name: string
  downloads: {
    PAPER?: {
      downloadUrl: string | null
      fileInfo: { name: string; sizeBytes: number; sha256Hash: string }
    }
  }
}

/** A template's plugins pinned as their catalogs serve them for Paper on VERSION today. */
async function pinned(
  mods: readonly { catalog?: string; projectId: string; dir?: string }[],
): Promise<PinnedMod[]> {
  return Promise.all(
    mods.map(async ({ catalog, projectId, dir }) => {
      if (catalog === 'hangar') return pinnedOnHangar(projectId)
      const query = `loaders=${encodeURIComponent('["paper"]')}&game_versions=${encodeURIComponent(`["${VERSION}"]`)}`
      const response = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version?${query}`)
      const [version] = (await response.json()) as {
        id: string
        name: string
        version_number: string
        loaders: string[]
        game_versions: string[]
        files: { url: string; filename: string; size: number; primary: boolean; hashes: { sha512: string } }[]
      }[]
      const file = version?.files.find((f) => f.primary) ?? version?.files[0]
      if (version === undefined || file === undefined)
        throw new Error(`${projectId} has nothing for ${VERSION}`)
      return {
        source: { catalog: 'modrinth', projectId, versionId: version.id },
        name: version.name,
        versionLabel: version.version_number,
        artifact: {
          ref: { kind: 'remote', url: file.url },
          sha512: file.hashes.sha512,
          sizeBytes: file.size,
          fileName: file.filename,
        },
        environment: 'server',
        loaders: version.loaders,
        gameVersions: version.game_versions,
        origin: 'user',
        requiredBy: [],
        ...(dir === undefined ? {} : { dir }),
      }
    }),
  )
}

export type BenchTemplate = 'paper' | 'skyblock' | 'fabric' | 'neoforge' | 'duels'

/**
 * The Fly machine config Cubepals gives a new Free server of the template, on `volumeId`; a bench
 * of many players raises its max players.
 */
export async function configFor(key: BenchTemplate, tier: MemoryTier, volumeId: string, maxPlayers = 10) {
  const template = templateOf(key === 'paper' ? 'smooth' : key)
  if (template === null) throw new Error(`no template ${key}`)
  const { setup } = template
  const revision: ServerRevision = {
    id: randomUUID(),
    serverId: SERVER_ID,
    number: 1,
    gameVersion: VERSION,
    loader: setup.loader,
    loaderVersion:
      setup.loader === 'paper'
        ? PAPER_BUILD
        : await loaderPin(new UpstreamLoaderBuilds(), setup.loader, VERSION),
    settings: {
      ...defaultSettings({ name: 'Suspend bench', gameMode: 'survival', maxPlayers }),
      ...setup.settings,
      onlineMode: false,
    },
    mods: await pinned(setup.mods),
    modpack: null,
    files: [...(setup.files ?? [])],
    acknowledgedRevoked: [],
    reason: 'created',
    basedOnRevisionId: null,
    createdBy: SERVER_ID,
  }
  const built = toRuntimeSpec({
    serverId: SERVER_ID,
    revision,
    world: {
      id: randomUUID(),
      serverId: SERVER_ID,
      levelName: 'world',
      name: 'World',
      seed: null,
      levelType: setup.world.levelType,
      hardcore: setup.world.hardcore,
      generatedOnVersion: VERSION,
    },
    memoryTier: tier,
    rconPassword: '',
    artifactUrl: (artifact) => (artifact.ref.kind === 'remote' ? artifact.ref.url : ''),
    // The Free plan's: no AFK kick, no border, 5 GB.
    limits: { playerIdleKickMinutes: null, worldRadius: null, storageGb: 5 },
    iconUrl: null,
  })
  // Its players join the server directly, not through the edge, so Paper reads no PROXY header.
  const { [PROXY_ENV]: _, ...env } = built.env
  const spec = { ...built, env }
  return { spec, config: machineConfig(spec, volumeId, { deployment: 'suspend-bench', server: SERVER_ID }) }
}

/** The bundle the probe machine runs: the probe, and the control-plane code it drives. */
async function probeBundle(): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), 'suspend-probe-'))
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'lib', 'suspend-probe.ts')],
    target: 'bun',
    outdir: out,
    naming: 'probe.js',
  })
  if (!built.success) throw new AggregateError(built.logs, 'the probe did not build')
  return join(out, 'probe.js')
}

/**
 * A probe machine: bun, mineflayer, the bundle, and the files the template code in it reads beside
 * itself. Ready once `/bench/ready` is there.
 */
async function startProbe(): Promise<string> {
  const setups = join(import.meta.dir, '..', 'apps', 'control', 'src', 'app', 'setups')
  const files = [
    `/bench/probe.js=${await probeBundle()}`,
    ...['aoneblock-config.yml', 'bskyblock-config.yml'].map((file) => `/bench/${file}=${join(setups, file)}`),
  ]
  const machine = ['-a', PROBE_APP, '-r', REGION, '--name', 'probe', '--vm-size', 'shared-cpu-2x']
  return fly([
    'machine',
    'run',
    'oven/bun:1.4.3-slim',
    ...machine,
    '--vm-memory',
    '1024',
    '--restart',
    'no',
    ...files.flatMap((file) => ['--file-local', file]),
    '--entrypoint',
    'sh',
    '--',
    '-c',
    'cd /bench && bun add mineflayer@4.39.0 && touch /bench/ready && sleep infinity',
  ]).trim()
}

export const machinesOf = (app: string) =>
  JSON.parse(fly(['machines', 'list', '-a', app, '--json'])) as { id: string; name: string }[]

/** The probe machine, made by `probe`. */
function probeMachine(): { id: string } {
  const [probe] = machinesOf(PROBE_APP)
  if (probe === undefined) throw new Error('no probe: run `probe` first')
  return probe
}

/** A probe job, left running on the probe machine; what it prints goes to `results`. */
function runOnProbe(args: readonly (string | undefined)[]): void {
  if (args.some((arg) => arg === undefined)) throw new Error(`not enough to run ${args.join(' ')}`)
  const line = `bun /bench/probe.js ${args.join(' ')} >> /bench/results.jsonl 2>> /bench/errors.log`
  const probe = probeMachine().id
  say(
    fly([
      'machine',
      'exec',
      probe,
      `sh -c 'cd /bench && setsid nohup ${line} < /dev/null &'`,
      '-a',
      PROBE_APP,
    ]),
  )
}

/** Each command, given what follows it, and the template and size the first two of those name. */
const COMMANDS: Record<string, (rest: string[], template: BenchTemplate, tier: MemoryTier) => Promise<void>> =
  {
    config: async (_, template, tier) =>
      say(JSON.stringify((await configFor(template, tier, 'vol_placeholder')).config, null, 2)),
    up: async (rest, template, tier) => {
      const name = `${template}-${tier}${rest[2] === undefined ? '' : `-${rest[2]}`}`
      const volume = JSON.parse(
        fly(['volumes', 'create', 'data', '-s', '5', '-r', REGION, '-a', MC_APP, '--yes', '--json']),
      ) as { id: string }
      const { config } = await configFor(template, tier, volume.id)
      const file = join(mkdtempSync(join(tmpdir(), 'suspend-bench-')), 'config.json')
      writeFileSync(file, JSON.stringify(config))
      const where = ['-a', MC_APP, '-r', REGION, '--name', name, '--machine-config', file]
      say(fly(['machine', 'create', config.image ?? '', ...where]).trim())
    },
    probe: async () => {
      // Both apps, made together so they share the console's password; RCON_PASSWORD is an app
      // secret, as a server's is. The probe drives Fly with the session's own token, an app secret
      // that nothing prints, gone with the app. Run again, it makes only a new probe machine.
      const apps = JSON.parse(fly(['apps', 'list', '-o', ORG, '--json'])) as { Name: string }[]
      if (!apps.some((app) => app.Name === PROBE_APP)) {
        const password = randomBytes(24).toString('hex')
        fly(['apps', 'create', MC_APP, '-o', ORG])
        fly(['secrets', 'import', '--stage', '-a', MC_APP], `RCON_PASSWORD=${password}\n`)
        fly(['apps', 'create', PROBE_APP, '-o', ORG])
        fly(
          ['secrets', 'import', '--stage', '-a', PROBE_APP],
          `FLY_API_TOKEN=${process.env.FLY_API_TOKEN ?? ''}\nRCON_PASSWORD=${password}\nBENCH_APP=${MC_APP}\n`,
        )
      }
      say(await startProbe())
    },
    run: async (rest) =>
      runOnProbe([rest[0], machinesOf(MC_APP).find((m) => m.name === rest[1])?.id, rest[2] ?? '5']),
    // A player through the edge needs only the server's address, and a flow makes its own server.
    join: async (rest) => runOnProbe(['edge-join', ...rest]),
    flow: async (rest, template, tier) => runOnProbe(['flow', template, tier, rest[2] ?? '3']),
    results: async () =>
      say(fly(['machine', 'exec', probeMachine().id, 'cat /bench/results.jsonl', '-a', PROBE_APP])),
    push: async () => {
      // A new probe for the jobs to come, in place of the one there: jobs running on it end.
      fly(['machine', 'destroy', probeMachine().id, '--force', '-a', PROBE_APP])
      say(await startProbe())
    },
    down: async () => {
      const apps = JSON.parse(fly(['apps', 'list', '-o', ORG, '--json'])) as { Name: string }[]
      const flows = apps.map((app) => app.Name).filter((name) => name.startsWith('bly-sbench-'))
      for (const app of [PROBE_APP, MC_APP, ...flows]) say(fly(['apps', 'destroy', app, '--yes']).trim())
    },
  }

// The probe imports `configFor` from here, and runs none of this.
if (import.meta.main) {
  const [command = '', ...rest] = process.argv.slice(2)
  const template = (
    ['skyblock', 'fabric', 'neoforge'].includes(rest[0] ?? '') ? rest[0] : 'paper'
  ) as BenchTemplate
  const run = COMMANDS[command]
  if (run === undefined) {
    say(`usage: bun scripts/suspend-bench.ts ${Object.keys(COMMANDS).join('|')} …`)
    process.exit(2)
  }
  await run(rest, template, (rest[1] ?? '3g') as MemoryTier)
}
