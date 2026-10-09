import { type SubmitEvent, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

interface Server {
  id: string
  name: string
  slug: string
  status: string
  stopReason: string | null
  memoryTier: string
  owner: string
  gameVersion: string | null
  loader: string | null
  maxPlayers: number | null
  players: string[]
  container: { id: string; state: string; status: string } | null
  addresses: { local: string; network?: string }
}

interface Operation {
  id: string
  kind: string
  status: string
  requestedBy: string
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

interface Line {
  key: number
  text: string
  kind: 'log' | 'command' | 'answer' | 'refused' | 'note'
}

// ─── The words and colours a state wears, the same ones the product's labels use ────────────

function stateOf(server: Server): { word: string; tone: string } {
  switch (server.status) {
    case 'running':
      return { word: 'Online', tone: 'online' }
    case 'provisioning':
    case 'starting':
    case 'updating':
    case 'restoring':
    case 'relocating':
    case 'stopping':
      return { word: server.status[0]?.toUpperCase() + server.status.slice(1), tone: 'working' }
    case 'failed':
      return { word: 'Failed', tone: 'danger' }
    case 'stopped':
      if (server.stopReason === 'crash') return { word: 'Crashed', tone: 'danger' }
      if (server.stopReason === 'policy' || server.stopReason === 'entitlement')
        return { word: 'Suspended', tone: 'danger' }
      return { word: 'Sleeping', tone: 'sleeping' }
    default:
      return { word: server.status, tone: 'quiet' }
  }
}

const levelOf = (text: string) =>
  /\/(ERROR|FATAL)\]|Exception|^\tat /.test(text) ? 'error' : /\/WARN\]/.test(text) ? 'warn' : 'info'

const ago = (iso: string | null) => {
  if (!iso) return '—'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86_400)}d ago`
}

const took = (op: Operation) => {
  if (!op.startedAt) return ''
  const end = op.finishedAt ? new Date(op.finishedAt).getTime() : Date.now()
  const seconds = (end - new Date(op.startedAt).getTime()) / 1000
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds / 60)}m`
}

// ─── The page ────────────────────────────────────────────────────────────────────────────────

function App() {
  const [servers, setServers] = useState<Server[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(() => location.hash.slice(1) || null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const response = await fetch('/api/servers')
        if (!response.ok) throw new Error(`the inspector answered ${response.status}`)
        const list = (await response.json()) as Server[]
        if (!alive) return
        setServers(list)
        setError(null)
        setSelected((current) => current ?? list[0]?.id ?? null)
      } catch (e) {
        if (alive) setError((e as Error).message)
      }
    }
    load()
    const timer = setInterval(load, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (selected) history.replaceState(null, '', `#${selected}`)
  }, [selected])

  const server = servers.find((s) => s.id === selected) ?? null
  return (
    <div className="shell">
      <aside className="list">
        <header className="brand">
          <span className="brand__mark">▦</span> Blockly inspector
          <span className="brand__note">dev only · this machine</span>
        </header>
        {error && <p className="banner banner--danger">{error}</p>}
        {servers.map((s) => {
          const state = stateOf(s)
          return (
            <button
              type="button"
              key={s.id}
              className={`row${s.id === selected ? ' row--on' : ''}`}
              onClick={() => setSelected(s.id)}
            >
              <span className={`dot dot--${state.tone}`} />
              <span className="row__body">
                <span className="row__name">{s.name}</span>
                <span className="row__meta">
                  {s.gameVersion} · {s.loader} · {s.owner.split('@')[0]}
                </span>
              </span>
              {s.players.length > 0 && <span className="row__count">{s.players.length}</span>}
            </button>
          )
        })}
        {servers.length === 0 && !error && <p className="quiet">No servers yet.</p>}
      </aside>
      <main className="detail">
        {server ? <Detail key={server.id} server={server} /> : <p className="quiet">Pick a server.</p>}
      </main>
    </div>
  )
}

function Detail({ server }: { server: Server }) {
  const state = stateOf(server)
  return (
    <>
      <header className="head">
        <div className="head__title">
          <h1>{server.name}</h1>
          <span className={`pill pill--${state.tone}`}>
            <span className={`dot dot--${state.tone}`} />
            {state.word}
          </span>
        </div>
        <dl className="facts">
          <div>
            <dt>Minecraft</dt>
            <dd>
              {server.gameVersion} {server.loader}
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{server.memoryTier.replace('g', ' GB')}</dd>
          </div>
          <div>
            <dt>Players</dt>
            <dd>
              {server.players.length} / {server.maxPlayers ?? '?'}
              {server.players.length > 0 && <span className="quiet"> · {server.players.join(', ')}</span>}
            </dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>{server.owner}</dd>
          </div>
          <div>
            <dt>Container</dt>
            <dd className="mono">
              {server.container ? `${server.container.id} · ${server.container.status}` : 'none yet'}
            </dd>
          </div>
        </dl>
        <div className="addresses">
          {server.addresses.network && <Address label="From your network" value={server.addresses.network} />}
          <Address label="On this Mac" value={server.addresses.local} />
        </div>
      </header>
      <section className="panes">
        <Logs server={server} />
        <Operations serverId={server.id} />
      </section>
    </>
  )
}

function Address({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="address"
      onClick={async () => {
        await navigator.clipboard?.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      <span className="address__label">{copied ? 'Copied' : label}</span>
      <span className="mono">{value}</span>
    </button>
  )
}

// ─── The log, and the console under it ───────────────────────────────────────────────────────

const KEEP = 3000

function Logs({ server }: { server: Server }) {
  const [lines, setLines] = useState<Line[]>([])
  const [follow, setFollow] = useState(true)
  const [filter, setFilter] = useState('')
  const [ended, setEnded] = useState<string | null>(null)
  const counter = useRef(0)
  const box = useRef<HTMLDivElement>(null)
  const awake = server.container?.state === 'running'

  const push = useCallback((text: string, kind: Line['kind']) => {
    setLines((current) => {
      const next = [...current, { key: counter.current++, text, kind }]
      return next.length > KEEP ? next.slice(next.length - KEEP) : next
    })
  }, [])

  // A new stream each time the server wakes: the tail it replays is the context to start from.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnects on waking, which is the point
  useEffect(() => {
    if (!server.container) return
    setLines([])
    setEnded(null)
    const events = new EventSource(`/api/servers/${server.id}/logs`)
    events.onmessage = (event) => push(JSON.parse(event.data) as string, 'log')
    events.addEventListener('end', (event) => {
      events.close()
      setEnded(JSON.parse((event as MessageEvent).data) as string)
    })
    return () => events.close()
  }, [server.id, awake, push])

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  })

  const shown = filter
    ? lines.filter((line) => line.text.toLowerCase().includes(filter.toLowerCase()))
    : lines
  return (
    <div className="pane pane--log">
      <div className="pane__bar">
        <h2>Log</h2>
        <input
          className="filter"
          placeholder="Filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <label className="toggle">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
          Follow
        </label>
        <button type="button" className="ghost" onClick={() => setLines([])}>
          Clear
        </button>
      </div>
      <div
        className="log"
        ref={box}
        onScroll={(event) => {
          const el = event.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          if (atBottom !== follow) setFollow(atBottom)
        }}
      >
        {!server.container && <p className="log__note">No container yet: the log starts when it is built.</p>}
        {shown.map((line) => (
          <div
            key={line.key}
            className={`log__line log__line--${line.kind === 'log' ? levelOf(line.text) : line.kind}`}
          >
            {line.text}
          </div>
        ))}
        {ended === 'asleep' && (
          <p className="log__note">Asleep. This is where it was left; the log picks up when it wakes.</p>
        )}
        {ended === 'stopped' && <p className="log__note">The server stopped.</p>}
      </div>
      <Console server={server} awake={awake} push={push} />
    </div>
  )
}

function Console({
  server,
  awake,
  push,
}: {
  server: Server
  awake: boolean
  push: (text: string, kind: Line['kind']) => void
}) {
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const history = useRef<string[]>([])
  const cursor = useRef(0)

  const send = async (event: SubmitEvent) => {
    event.preventDefault()
    const typed = command.trim()
    if (!typed || busy) return
    history.current = [...history.current.filter((h) => h !== typed), typed].slice(-50)
    cursor.current = history.current.length
    setCommand('')
    setBusy(true)
    push(`> ${typed}`, 'command')
    try {
      const response = await fetch(`/api/servers/${server.id}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: typed }),
      })
      const { ok, output } = (await response.json()) as { ok: boolean; output: string }
      for (const line of (output || (ok ? 'Done.' : 'No answer.')).split('\n'))
        push(line, ok ? 'answer' : 'refused')
    } catch (e) {
      push((e as Error).message, 'refused')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="console" onSubmit={send}>
      <span className="console__prompt">/</span>
      <input
        value={command}
        disabled={!awake}
        placeholder={
          awake ? 'say hello, time set day, gamemode creative Steve…' : 'Asleep: wake it to run commands'
        }
        onChange={(event) => setCommand(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' && cursor.current > 0) {
            cursor.current -= 1
            setCommand(history.current[cursor.current] ?? '')
            event.preventDefault()
          }
          if (event.key === 'ArrowDown') {
            cursor.current = Math.min(history.current.length, cursor.current + 1)
            setCommand(history.current[cursor.current] ?? '')
            event.preventDefault()
          }
        }}
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" disabled={!awake || busy || !command.trim()}>
        {busy ? 'Running' : 'Run'}
      </button>
    </form>
  )
}

// ─── What Blockly did to it ──────────────────────────────────────────────────────────────────

function Operations({ serverId }: { serverId: string }) {
  const [ops, setOps] = useState<Operation[]>([])
  useEffect(() => {
    let alive = true
    const load = async () => {
      const response = await fetch(`/api/servers/${serverId}/operations`).catch(() => null)
      if (alive && response?.ok) setOps((await response.json()) as Operation[])
    }
    load()
    const timer = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [serverId])

  return (
    <div className="pane pane--ops">
      <div className="pane__bar">
        <h2>Operations</h2>
      </div>
      <ol className="ops">
        {ops.map((op) => (
          <li key={op.id} className="op">
            <span className={`op__status op__status--${op.status}`}>{op.status}</span>
            <span className="op__kind">{op.kind}</span>
            <span className="op__meta">
              {op.requestedBy.split(':')[0]} · {ago(op.createdAt)}
              {took(op) && ` · ${took(op)}`}
            </span>
            {op.error && <span className="op__error">{op.error}</span>}
          </li>
        ))}
        {ops.length === 0 && <li className="quiet">Nothing yet.</li>}
      </ol>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
