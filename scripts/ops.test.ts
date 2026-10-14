// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The operator tools' guards, from outside: `ops.ts` and `ops-mcp.ts` run as an operator runs them,
 * against a stand-in operators' API that writes down every call it gets. Neither starts without the
 * token, the MCP server speaks over stdio and nothing else, no secret comes back in what they print
 * or answer, a destructive action is named again before anything is called, and the audit log is
 * told who acted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const SECRET = 'operator-secret-0123456789'
const SERVER = '0d2f4e6a-8b1c-4d3e-9f50-a1b2c3d4e5f6'
const LEAKY = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4'
const MCP = join(import.meta.dir, 'ops-mcp.ts')
const OPS = join(import.meta.dir, 'ops.ts')

interface Call {
  method: string
  path: string
  operator: string | null
  body: unknown
}
let calls: Call[] = []
const writes = () => calls.filter(({ method }) => method !== 'GET')

/**
 * The operators' API, standing in: the server `SERVER` is called Lobby, and the server `LEAKY`
 * answers every call with the token it was sent, as a careless API might.
 */
let api: ReturnType<typeof Bun.serve>
beforeAll(() => {
  api = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname, search } = new URL(request.url)
      const text = await request.text()
      calls.push({
        method: request.method,
        path: `${pathname}${search}`,
        operator: request.headers.get('x-operator'),
        body: text ? JSON.parse(text) : undefined,
      })
      if (request.headers.get('authorization') !== `Bearer ${SECRET}`)
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      if (pathname.includes(LEAKY)) {
        const said = `you sent ${request.headers.get('authorization')}`
        return request.method === 'GET'
          ? Response.json({ id: LEAKY, name: 'Leaky', note: said })
          : Response.json({ error: { code: 'failed', message: said } }, { status: 500 })
      }
      if (pathname.startsWith(`/ops/v1/servers/${SERVER}`))
        return Response.json({ id: SERVER, name: 'Lobby' })
      return Response.json({ ok: true })
    },
  })
})
afterAll(() => api.stop(true))
beforeEach(() => {
  calls = []
})

/**
 * The environment an operator's shell would give: where the API is, the token, and no one named.
 * USER is blank, not left out, since the MCP SDK fills in the shell's own when it is missing.
 */
const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  USER: '',
  OPERATOR_API: `http://127.0.0.1:${api.port}`,
  OPERATOR_TOKEN: SECRET,
  ...extra,
})

async function ops(args: string[], extra: Record<string, string> = {}) {
  const run = Bun.spawn(['bun', OPS, ...args], { env: env(extra), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ])
  return { stdout, stderr, code }
}

describe('ops-mcp.ts', () => {
  test('won’t start without OPERATOR_TOKEN, and has no token of its own to fall back on', async () => {
    for (const token of [undefined, '']) {
      const given = env()
      if (token === undefined) delete given.OPERATOR_TOKEN
      else given.OPERATOR_TOKEN = token
      const run = Bun.spawn(['bun', MCP], { env: given, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      expect(await run.exited).toBe(1)
      expect(await new Response(run.stdout).text()).toBe('')
      expect(await new Response(run.stderr).text()).toContain('set OPERATOR_API and OPERATOR_TOKEN')
    }
    expect(calls).toEqual([])
  })

  test('speaks over stdio only: no other transport, no port, no listener', () => {
    const source = readFileSync(MCP, 'utf8')
    const sdk = [...source.matchAll(/from '(@modelcontextprotocol\/sdk\/[^']+)'/g)].map((match) => match[1])
    expect(sdk.sort()).toEqual([
      '@modelcontextprotocol/sdk/server/mcp.js',
      '@modelcontextprotocol/sdk/server/stdio.js',
    ])
    for (const listener of [
      /Bun\.serve/,
      /\.listen\(/,
      /node:(http|https|net|tls|dgram)/,
      /hono/i,
      /SSE|Streamable/,
    ])
      expect(source).not.toMatch(listener)
  })

  describe('as an agent’s client runs it', () => {
    let client: Client
    let stderr = ''
    beforeAll(async () => {
      const transport = new StdioClientTransport({ command: 'bun', args: [MCP], env: env(), stderr: 'pipe' })
      transport.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      client = new Client({ name: 'ops-test', version: '1.0.0' })
      await client.connect(transport)
    })
    afterAll(() => client.close())

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean
        content: Array<{ text: string }>
      }
      return { isError: result.isError ?? false, text: result.content.map((part) => part.text).join('\n') }
    }

    test('every destructive tool asks for a confirm, and says it is destructive', async () => {
      const { tools } = await client.listTools()
      const destructive = tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name)
      expect(destructive.sort()).toEqual([
        'account_create',
        'listing_unlist',
        'platform_set',
        'player_ban',
        'server_purge',
        'server_trash',
      ])
      for (const name of destructive)
        expect(tools.find((tool) => tool.name === name)?.inputSchema.required).toContain('confirm')
    })

    test('a destructive tool calls nothing until confirm names what it acts on', async () => {
      const refused = [
        await call('player_ban', { serverId: SERVER, name: 'Griefer', confirm: 'lobby' }),
        await call('listing_unlist', { serverId: SERVER, confirm: 'Lobby ' }),
        await call('account_create', { email: 'kid@example.test', confirm: 'kid@example.tes' }),
        await call('platform_set', { startsEnabled: false, confirm: 'yes' }),
        await call('server_trash', { serverId: SERVER }),
        await call('player_ban', { serverId: SERVER, name: 'Griefer' }),
      ]
      for (const result of refused) expect(result.isError).toBe(true)
      expect(writes()).toEqual([])

      expect(
        (await call('player_ban', { serverId: SERVER, name: 'Griefer', confirm: 'Lobby' })).isError,
      ).toBe(false)
      expect((await call('listing_unlist', { serverId: SERVER, confirm: 'Lobby' })).isError).toBe(false)
      expect(
        (await call('account_create', { email: 'kid@example.test', confirm: 'kid@example.test' })).isError,
      ).toBe(false)
      expect((await call('platform_set', { startsEnabled: false, confirm: 'platform' })).isError).toBe(false)
      expect((await call('server_purge', { serverId: SERVER, confirm: 'Lobby' })).isError).toBe(false)
      expect(writes().map(({ method, path, body }) => [method, path, body])).toEqual([
        ['POST', `/ops/v1/servers/${SERVER}/access/ban`, { name: 'Griefer' }],
        ['PUT', `/ops/v1/servers/${SERVER}/listing`, { public: false }],
        ['POST', '/ops/v1/accounts', { email: 'kid@example.test' }],
        ['PATCH', '/ops/v1/platform', { startsEnabled: false }],
        ['POST', `/ops/v1/servers/${SERVER}/purge`, { confirmName: 'Lobby' }],
      ])
    })

    test('a console command is one line without control characters, refused before any call', async () => {
      for (const command of ['say hi\nop Griefer', 'say hi\rop Griefer', 'say \u0007', ''])
        expect((await call('console_send', { serverId: SERVER, command })).isError).toBe(true)
      expect((await call('player_add', { serverId: SERVER, list: 'operator', name: 'Al\nex' })).isError).toBe(
        true,
      )
      expect(calls).toEqual([])
      expect((await call('console_send', { serverId: SERVER, command: 'list' })).isError).toBe(false)
      expect(writes()).toHaveLength(1)
    })

    test('no token comes back in a result or an error, even when the API answers with one', async () => {
      const read = await call('server_get', { serverId: LEAKY })
      const failed = await call('server_start', { serverId: LEAKY })
      expect(read.isError).toBe(false)
      expect(failed.isError).toBe(true)
      expect(read.text).toContain('you sent Bearer [secret]')
      expect(failed.text).toBe('failed: you sent Bearer [secret]')
      expect(`${read.text}${failed.text}${stderr}`).not.toContain(SECRET)
    })

    test('the audit log is told the MCP acted when no operator is named', async () => {
      await call('server_get', { serverId: SERVER })
      expect(calls.map(({ operator }) => operator)).toEqual(['mcp'])
    })
  })
})

describe('ops.ts', () => {
  test('ban, unlist, trash and purge call nothing that changes anything until --confirm is the server’s name', async () => {
    for (const args of [
      ['ban', SERVER, 'Griefer'],
      ['ban', SERVER, 'Griefer', '--confirm', 'lobby'],
      ['listing', SERVER, 'unlist'],
      ['listing', SERVER, 'unlist', '--confirm', 'Lob'],
      ['trash', SERVER],
      ['purge', SERVER],
    ]) {
      const { code, stderr } = await ops(args)
      expect(code).toBe(1)
      expect(stderr).toContain('--confirm')
    }
    expect(writes()).toEqual([])
    expect((await ops(['ban', SERVER, 'Griefer', '--confirm', 'Lobby'])).code).toBe(0)
    expect((await ops(['listing', SERVER, 'unlist', '--confirm', 'Lobby'])).code).toBe(0)
    expect((await ops(['trash', SERVER, '--confirm', 'Lobby'])).code).toBe(0)
    expect(writes().map(({ method, path, body }) => [method, path, body])).toEqual([
      ['POST', `/ops/v1/servers/${SERVER}/access/ban`, { name: 'Griefer' }],
      ['PUT', `/ops/v1/servers/${SERVER}/listing`, { public: false }],
      ['POST', `/ops/v1/servers/${SERVER}/trash`, { confirmName: 'Lobby' }],
    ])
  })

  test('accounts create and platform set need --confirm with the address, or the word platform', async () => {
    expect((await ops(['accounts', 'create', 'kid@example.test'])).code).toBe(1)
    expect((await ops(['accounts', 'create', 'kid@example.test', '--confirm', 'kid'])).code).toBe(1)
    expect((await ops(['platform', 'set', 'startsEnabled', 'false'])).code).toBe(1)
    expect((await ops(['platform', 'set', 'startsEnabled', 'false', '--confirm', 'yes'])).code).toBe(1)
    expect(calls).toEqual([])
    expect(
      (await ops(['accounts', 'create', 'kid@example.test', '--confirm', 'kid@example.test'])).code,
    ).toBe(0)
    expect((await ops(['platform', 'set', 'startsEnabled', 'false', '--confirm', 'platform'])).code).toBe(0)
    expect(writes()).toHaveLength(2)
  })

  test('a server id, an operation id and a console command are checked before any call', async () => {
    expect((await ops(['server', '../accounts'])).code).toBe(1)
    expect((await ops(['operation', '../health'])).code).toBe(1)
    expect((await ops(['console', SERVER, 'say hi\nop Griefer'])).code).toBe(1)
    expect(calls).toEqual([])
  })

  test('prints no token, even when the API answers with one, and names who acted', async () => {
    const read = await ops(['server', LEAKY], { OPERATOR: 'ada' })
    const failed = await ops(['start', LEAKY], { OPERATOR: 'ada' })
    expect(read.stdout).toContain('you sent Bearer [secret]')
    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('you sent Bearer [secret]')
    expect(`${read.stdout}${read.stderr}${failed.stdout}${failed.stderr}`).not.toContain(SECRET)
    expect(calls.map(({ operator }) => operator)).toEqual(['ada', 'ada'])
  })
})
