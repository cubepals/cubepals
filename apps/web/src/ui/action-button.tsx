'use client'

import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { newId } from '../lib/ids'
import { Button, type ButtonProps } from './Button'
import { ICON } from './index'

const wait = (ms: number) => new Promise((done) => setTimeout(done, Math.max(0, ms)))

/** How long the working words stay up, however fast the work was. */
const HELD_MS = 650
/** How long a failure stays on the button before it settles back. */
const FAILED_MS = 2600

/** One of the things a button can be: waking a world, putting it to sleep, starting it again. */
export interface Phase {
  icon: ReactNode
  label: string
  /** What it says while this phase's work runs: "Waking it up". */
  working: string
  /** What it says for the moment after this phase's work failed. */
  failed: string
  /**
   * What it says for the moment after the server finished this phase's work: "Awake". A button
   * in a dialog or row that closes once its work lands needs none.
   */
  done?: string
  variant: ButtonProps['variant']
  run: (requestId: string) => Promise<unknown>
}

/**
 * The one button for something that takes a moment and can fail. It stays one button through all
 * of it — every phase's icon is mounted, and only one is shown — so the colour and the icon have
 * something to move from, and a state change is watched rather than found already done. Swapping
 * one button element for another is what made the morph invisible before.
 *
 * It answers the press itself: the phase's working words go up as the click lands and stay long
 * enough to read, however fast the control plane answers. One press is one action, however many
 * times it is clicked — a ref, not state, holds the press, so a second click in the same tick
 * sees it, and the work is asked for once with one request id.
 *
 * A failure turns the button danger-coloured with a warning for a moment, then settles back to
 * where it started. The reason belongs beside it, which is the caller's to show.
 *
 * Once the server has finished the work a press started (`said`, from `useOutcome`), the button
 * says so for a moment, a check and the pressed phase's `done` word, before it takes the phase the
 * server is in now: a wake is seen to land as "Awake" before the button offers sleep.
 */
export function ActionButton({
  phases,
  now,
  busy,
  said,
  disabled,
  ...rest
}: {
  /** Every phase this button can be in, by name. All their icons stay mounted. */
  phases: Record<string, Phase>
  /** The phase it is in now. */
  now: string
  /** Set while the server itself is busy with something: the words to show meanwhile. */
  busy?: string | undefined
  /** How the server's work for the last press ended, while that is worth saying. */
  said?: 'done' | 'failed' | null
} & Omit<ButtonProps, 'icon' | 'children' | 'onClick' | 'variant'>) {
  const [state, setState] = useState<'idle' | 'working' | 'failed'>('idle')
  // The phase that was pressed: what finished is its work, whatever phase the server is in now.
  const [pressed, setPressed] = useState(now)
  // A ref, not the state, is what a second click in the same tick can see.
  const inFlight = useRef(false)
  const phase = phases[now]
  if (phase === undefined) throw new Error(`no phase called ${now}`)
  const ended = phases[pressed] ?? phase

  const working = state === 'working' || busy !== undefined
  const failed = !working && (state === 'failed' || said === 'failed')
  const done = !working && !failed && said === 'done' && ended.done !== undefined
  const press = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setPressed(now)
    setState('working')
    const pressedAt = Date.now()
    try {
      await phase.run(newId())
      // A wake the control plane answers in eighty milliseconds is still a wake the person asked
      // for: the working words are held long enough to read before the server's own take over.
      await wait(HELD_MS - (Date.now() - pressedAt))
      setState('idle')
    } catch {
      setState('failed')
      setTimeout(() => setState('idle'), FAILED_MS)
    } finally {
      inFlight.current = false
    }
  }

  return (
    <Button
      {...rest}
      variant={working ? 'working' : failed ? 'danger' : done ? 'done' : phase.variant}
      className={['bk-btn--morphing', working && 'bk-btn--busy'].filter(Boolean).join(' ')}
      disabled={disabled}
      aria-busy={working}
      aria-live="polite"
      icon={
        <span className="bk-btn__icon bk-swap" aria-hidden>
          {/* Every phase's icon stays mounted, so one can fade into the next. */}
          {Object.entries(phases).map(([name, each]) => (
            <span key={name} data-shown={!working && !failed && !done && name === now}>
              {each.icon}
            </span>
          ))}
          <Loader2 {...ICON} className="bk-spin" data-shown={working} />
          <AlertTriangle {...ICON} data-shown={failed} />
          <Check {...ICON} data-shown={done} />
        </span>
      }
      onClick={press}
    >
      {busy ??
        (state === 'working' ? phase.working : failed ? ended.failed : done ? ended.done : phase.label)}
    </Button>
  )
}
