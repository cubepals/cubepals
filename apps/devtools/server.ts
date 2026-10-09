/**
 * The dev inspector: `bun run devtools`, then http://localhost:4040.
 *
 * A small React app beside the stack for development, showing what is actually happening rather
 * than a terminal command per question: every server with its live state, a server's game log
 * as it happens, a console to type commands into, and what Blockly last did to it.
 *
 * It reads the database and drives Docker, which is everything, so it answers on loopback only
 * and never ships: nothing here is deployed, and there is no sign-in because nothing but this
 * machine can reach it. Commands and logs go only to containers Blockly labelled as a server.
 */
import { networkInterfaces } from 'node:os'
import { SQL } from 'bun'
import page from './index.html'

const PORT = Number(process.env.DEVTOOLS_PORT ?? 4040)
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set: run this from the repository root, where .env is.')
  process.exit(1)
}
const db = new SQL(DATABASE_URL)
const PLAY_DOMAIN = process.env.PLAY_DOMAIN ?? 'play.localhost'
const LAN = Object.values(networkInterfaces())
  .flat()
  .find((net) => net !== undefined && net.family === 'IPv4' && !net.internal)?.address

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Container {
  id: string
  state: string
  status: string
}

/** Blockly's own game containers, by the server they belong to. */
async function containers(): Promise<Map<string, Container>> {
  const out = await new Response(
    Bun.spawn(['docker', 'ps', '-a', '--filter', 'label=blockly.server', '--format', '{{json .}}'], {
      stdout: 'pipe',
      stderr: 'ignore',
    }).stdout,
  ).text()
  const found = new Map<string, Container>()
  for (const line of out.split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as { ID: string; State: string; Status: string; Labels: string }
    const server = row.Labels.split(',').find((label) => label.startsWith('blockly.server='))
    if (server)
      found.set(server.slice('blockly.server='.length), { id: row.ID, state: row.State, status: row.Status })
  }
  return found
}

/** The container of a server, only when the id is a server's and Blockly made the container. */
async function containerOf(serverId: string): Promise<Container | null> {
  if (!UUID.test(serverId)) return null
  return (await containers()).get(serverId) ?? null
}

async function servers() {
  const rows = await db`
    select s.id, s.name, s.slug, s.status, s.stop_reason as "stopReason", s.memory_tier as "memoryTier",
           s.created_at as "createdAt", u.email as owner, r.game_version as "gameVersion", r.loader,
           (r.settings->>'maxPlayers')::int as "maxPlayers",
           coalesce((select json_agg(p.player_name order by p.player_name) from server_presence p
                     where p.server_id = s.id), '[]') as players
    from minecraft_servers s
    join users u on u.id = s.owner_id
    left join server_revisions r on r.id = s.desired_revision_id
    where s.deleted_at is null
    order by s.created_at desc`
  const running = await containers()
  return rows.map((row: Record<string, unknown>) => ({
    ...row,
    container: running.get(String(row.id)) ?? null,
    addresses: {
      local: `${row.slug}.${PLAY_DOMAIN}`,
      ...(LAN ? { network: `${row.slug}.${LAN}.nip.io` } : {}),
    },
  }))
}

async function operations(serverId: string) {
  if (!UUID.test(serverId)) return []
  return db`
    select id, kind, status, requested_by as "requestedBy", error, created_at as "createdAt",
           started_at as "startedAt", finished_at as "finishedAt"
    from server_operations where server_id = ${serverId}
    order by created_at desc limit 25`
}

/** A log line as text: the image's start-up scripts colour theirs with ANSI escapes. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what is being removed
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r$/, '')

/**
 * The game log as it happens, over server-sent events, until the page goes away. A sleeping
 * server's log is sent as it was left, then an `end` event: following a stopped container would
 * end at once and have the page reconnect in a loop.
 */
function logs(container: Container, signal: AbortSignal): Response {
  const follow = container.state === 'running'
  const docker = Bun.spawn(
    ['docker', 'logs', ...(follow ? ['--follow'] : []), '--tail', '400', container.id],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  signal.addEventListener('abort', () => docker.kill())
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder()
        let rest = ''
        for await (const chunk of stream) {
          rest += decoder.decode(chunk, { stream: true })
          const lines = rest.split('\n')
          rest = lines.pop() ?? ''
          for (const line of lines)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(plain(line))}\n\n`))
        }
      }
      await Promise.all([pump(docker.stdout), pump(docker.stderr)]).catch(() => undefined)
      controller.enqueue(
        encoder.encode(`event: end\ndata: ${JSON.stringify(follow ? 'stopped' : 'asleep')}\n\n`),
      )
      controller.close()
    },
    cancel() {
      docker.kill()
    },
  })
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
  })
}

/** One command, as an operator would type it in game, through the server's own RCON. */
async function run(container: string, command: string) {
  const docker = Bun.spawn(['docker', 'exec', container, 'rcon-cli', command], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(docker.stdout).text(),
    new Response(docker.stderr).text(),
    docker.exited,
  ])
  return { ok: code === 0, output: (out || err).replace(/§./g, '').trim() }
}

const server = Bun.serve({
  port: PORT,
  // Loopback only: this reads the database and runs commands in game servers.
  hostname: '127.0.0.1',
  development: true,
  idleTimeout: 0,
  routes: {
    '/': page,
    '/api/servers': async () => Response.json(await servers()),
    '/api/servers/:id/operations': async (request) => Response.json(await operations(request.params.id)),
    '/api/servers/:id/logs': async (request) => {
      const container = await containerOf(request.params.id)
      if (!container) return new Response('That server has no container.', { status: 404 })
      return logs(container, request.signal)
    },
    '/api/servers/:id/command': {
      POST: async (request) => {
        const container = await containerOf(request.params.id)
        if (!container)
          return Response.json({ ok: false, output: 'That server has no container.' }, { status: 404 })
        if (container.state !== 'running')
          return Response.json({ ok: false, output: 'It is asleep. Wake it first.' }, { status: 409 })
        const { command } = (await request.json()) as { command?: unknown }
        if (
          typeof command !== 'string' ||
          command.trim() === '' ||
          command.length > 256 ||
          /[\r\n]/.test(command)
        )
          return Response.json({ ok: false, output: 'One line, up to 256 characters.' }, { status: 400 })
        return Response.json(await run(container.id, command.trim().replace(/^\//, '')))
      },
    },
  },
})

console.warn(`Blockly dev inspector on http://localhost:${server.port} (this machine only)`)
