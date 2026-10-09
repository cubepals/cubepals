'use client'

import { type SubmitEvent, useEffect, useRef, useState } from 'react'
import { Tabs } from './interactive'

export interface ConsoleLine {
  id: string
  time: string
  text: string
  level: 'info' | 'warn' | 'error' | 'chat' | 'setup'
}

type Filter = 'all' | 'chat' | 'warn' | 'error'

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'chat', label: 'Chat' },
  { value: 'warn', label: 'Warnings' },
  { value: 'error', label: 'Errors' },
]

/**
 * The server's own voice. A calm reading surface: chat brightest, severity as a bar, never a
 * terminal costume. It follows the newest line until the person scrolls up to read.
 */
export function Console({
  lines,
  onSubmit,
  disabled,
  maxHeight = '60vh',
}: {
  lines: ConsoleLine[]
  onSubmit?: (command: string) => Promise<void>
  disabled?: boolean
  maxHeight?: string
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [command, setCommand] = useState('')
  const list = useRef<HTMLOListElement>(null)
  const following = useRef(true)
  const shown = filter === 'all' ? lines : lines.filter((l) => l.level === filter)

  useEffect(() => {
    const element = list.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  })

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const text = command.trim()
    if (!text || !onSubmit) return
    setCommand('')
    following.current = true
    await onSubmit(text)
  }

  return (
    <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
      <Tabs label="Show" items={FILTERS} value={filter} onChange={setFilter} />
      <div className="bk-console">
        {shown.length === 0 ? (
          <p className="bk-console__empty">
            {lines.length === 0
              ? 'Nothing has happened yet. Chat and server messages will show up here.'
              : 'Nothing like that yet.'}
          </p>
        ) : (
          <ol
            ref={list}
            className="bk-console__lines"
            style={{ maxHeight }}
            aria-live="polite"
            onScroll={(event) => {
              const el = event.currentTarget
              following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            }}
          >
            {shown.map((line) => (
              <li key={line.id} className={`bk-console__line bk-console__line--${line.level}`}>
                <span className="bk-console__bar" aria-hidden />
                <span className="bk-console__time">{line.time}</span>
                {/* Blockly getting the server ready, said plainly, so nobody reads it as the game. */}
                {line.level === 'setup' && <span className="bk-console__who">Cubepals</span>}
                <span className="bk-console__text">{line.text}</span>
              </li>
            ))}
          </ol>
        )}
        {onSubmit && (
          <form className="bk-console__form" onSubmit={submit}>
            <label className="bk-visually-hidden" htmlFor="console-command">
              Command
            </label>
            <input
              id="console-command"
              className="bk-console__input"
              placeholder={disabled ? 'Start the server to send commands' : 'Type a command or message'}
              value={command}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setCommand(event.target.value)}
            />
          </form>
        )}
      </div>
    </div>
  )
}
