/**
 * Whether a Fly volume snapshot holds the volume as it was when it was asked for, or as it was
 * some time later. On a running server's app:
 *
 *   bun scripts/snapshot-probe.ts bly-staging-<server id>
 *
 * A ticker on the server's machine writes the time into its volume four times a second, each
 * write synced. A marker is written just before the snapshot is asked for, and another just after
 * Fly accepts it. The snapshot is then restored to a new volume on a helper machine in the same
 * app, and read: the last tick it holds is the moment it captured. Both are destroyed after.
 */
import { flyCredentials } from '../apps/control/src/infra/fly/token.ts'

const app = process.argv[2]
if (!app?.startsWith('bly-staging-')) {
  process.stdout.write('usage: bun scripts/snapshot-probe.ts bly-staging-<server id>\n')
  process.exit(2)
}
const { authorization } = flyCredentials(process.env.FLY_API_TOKEN ?? '')
const say = (line: string) => process.stdout.write(`${line}\n`)
const now = () => performance.timeOrigin + performance.now()

// biome-ignore lint/suspicious/noExplicitAny: Fly's answers, read loosely for a probe
async function fly(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`https://api.machines.dev/v1/apps/${app}${path}`, {
    method,
    headers: { authorization, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`)
  return text === '' ? null : JSON.parse(text)
}
const exec = async (machineId: string, script: string) =>
  (await fly('POST', `/machines/${machineId}/exec`, { command: ['sh', '-c', script], timeout: 30 })) as {
    stdout?: string
    stderr?: string
    exit_code?: number
  }

// biome-ignore lint/suspicious/noExplicitAny: as above
const machine = ((await fly('GET', '/machines')) as any[]).find(
  (m) => m.config?.metadata?.blockly_role === 'minecraft' && m.state === 'started',
)
if (machine === undefined) throw new Error('no running Minecraft machine in that app')
// biome-ignore lint/suspicious/noExplicitAny: as above
const volume = ((await fly('GET', '/volumes')) as any[]).find(
  (v) => v.name === 'minecraft_data' && v.state === 'created',
)
say(`machine ${machine.id}, volume ${volume.id} (${volume.size_gb} GB, ${volume.region})`)

// Nanoseconds since the epoch, as the machine's clock says; the machine and this script agree to
// well within the resolution this needs, which the before and after markers check.
await exec(
  machine.id,
  "rm -f /data/probe-*; nohup sh -c 'i=0; while [ $i -lt 1200 ]; do date +%s%N > /data/probe-tick; date +%s%N >> /data/probe-ticks; sync; sleep 0.25; i=$((i+1)); done' > /dev/null 2>&1 & echo $! > /tmp/probe.pid",
)
await Bun.sleep(3000)
const ticking = (await exec(machine.id, 'wc -l < /data/probe-ticks')).stdout?.trim()
say(`ticker running: ${ticking} ticks so far`)

await exec(machine.id, 'date +%s%N > /data/probe-before; sync')
const asked = now()
await fly('POST', `/volumes/${volume.id}/snapshots`)
const accepted = now()
await exec(machine.id, 'date +%s%N > /data/probe-after; sync')
const afterWritten = now()
say(
  `asked at ${asked.toFixed(0)}, accepted after ${(accepted - asked).toFixed(0)} ms, after-marker ${(afterWritten - asked).toFixed(0)} ms`,
)

// Every change in how Fly lists the snapshot, and in how it lists the volume, with when it was
// seen: whether anything it says marks the moment the snapshot captured.
let snapshot: { id: string; status: string; created_at: string; size: number } | undefined
let said = ''
for (;;) {
  const listed = (await fly('GET', `/volumes/${volume.id}/snapshots`)) as NonNullable<typeof snapshot>[]
  snapshot = listed.toSorted((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)).at(-1)
  const { state, snapshot_retention, ...rest } = await fly('GET', `/volumes/${volume.id}`)
  const saying = JSON.stringify({ snapshot, volume: { state, blocks: rest.blocks_free } })
  if (saying !== said) say(`  ${((now() - asked) / 1000).toFixed(2)} s: ${saying}`)
  said = saying
  if (snapshot?.status === 'created' && Date.parse(snapshot.created_at) >= asked - 60_000) break
  if (snapshot?.status === 'failed') throw new Error('the snapshot failed')
  await Bun.sleep(250)
}
const finished = now()
say(
  `snapshot ${snapshot.id}: listed as made at ${snapshot.created_at}, finished after ${((finished - asked) / 1000).toFixed(1)} s, ${snapshot.size} bytes`,
)

const restored = await fly('POST', '/volumes', {
  name: 'probe',
  region: volume.region,
  size_gb: volume.size_gb,
  snapshot_id: snapshot.id,
  auto_backup_enabled: false,
})
let helper: { id: string } | null = null
try {
  for (let i = 0; i < 900; i++) {
    if ((await fly('GET', `/volumes/${restored.id}`)).state === 'created') break
    await Bun.sleep(1000)
  }
  helper = await fly('POST', '/machines', {
    name: 'snapshot-probe',
    region: volume.region,
    config: {
      image: 'curlimages/curl:8.22.0',
      init: { exec: ['/bin/sleep', '3600'] },
      guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 256 },
      mounts: [{ volume: restored.id, path: '/probe' }],
      restart: { policy: 'no' },
      auto_destroy: true,
      metadata: { blockly_role: 'helper' },
    },
  })
  const helperId = helper?.id ?? ''
  await fly('GET', `/machines/${helperId}/wait?state=started&timeout=60`)
  const read = await exec(
    helperId,
    'for f in before tick after; do printf "%s " "$f"; cat /probe/probe-$f 2>/dev/null || echo missing; done',
  )
  const held = Object.fromEntries(
    (read.stdout ?? '')
      .trim()
      .split('\n')
      .map((line) => line.split(' ') as [string, string]),
  )
  const at = (ns: string | undefined) =>
    ns === undefined || ns === 'missing'
      ? 'missing'
      : `${((Number(BigInt(ns) / 1000000n) - asked) / 1000).toFixed(2)} s`
  say(
    `the snapshot holds: before-marker ${at(held.before)}, last tick ${at(held.tick)}, after-marker ${at(held.after)} (relative to the ask)`,
  )
  say(
    held.after === 'missing' &&
      held.before !== 'missing' &&
      Number(BigInt(held.tick ?? '0') / 1000000n) < accepted + 1000
      ? 'point in time: it holds the volume as it was when asked for'
      : 'NOT point in time: it holds writes made after it was asked for',
  )
} finally {
  if (helper !== null) await fly('DELETE', `/machines/${helper.id}?force=true`).catch(() => undefined)
  for (let i = 0; i < 30; i++) {
    const gone = await fly('DELETE', `/volumes/${restored.id}`).then(
      () => true,
      () => false,
    )
    if (gone) break
    await Bun.sleep(2000)
  }
  await exec(machine.id, 'kill "$(cat /tmp/probe.pid)"; rm -f /data/probe-* /tmp/probe.pid').catch(
    () => undefined,
  )
}
