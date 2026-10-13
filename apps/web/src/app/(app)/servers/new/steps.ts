// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What the create page reports, so it can be seen where people stop. Every event is named
 * `create_*` and listed here with what it carries:
 *
 * - `create_opened`, once a view: `first_server` (the account has no live server yet) once the
 *   page knows, and `source` where it opened with a choice made: `copy` of a server, `replace` of
 *   one that never started, or a way to play carried back from paying (`template`, `curated`,
 *   `modpack`, `import`), with the template's or pack's `key` where it has one.
 * - `create_chose`, once a field has settled on a choice: `field` (`play`, `version`, `region`,
 *   `size`, `name`, `for_a_day`) and the choice: `kind` and `key` for what to play, `value` for a
 *   release, region or size, `on` for a day, and for the name only `filled`, never what it says.
 * - `create_blocked`, as a reason the server can't be made is shown: its `reason` code.
 * - `create_pressed`; then `create_done`, or `create_refused` with the refusal's `code`.
 * - `create_acted`, a press that chooses nothing yet: `action` (one of `ACTS`: opening or closing
 *   "More ways to play", going to the packs or the upload and back, pressing a pack, opening the
 *   server types), and for a search, `pack_searched` with `results`, how many came back, or
 *   `pack_linked` with `found`, whether a pasted link was a pack. Never what was typed.
 * - `create_seen`, once each, as a part of the page first comes into view: `what` (`size`,
 *   `name`, or `button` for the Create button, with `ready`, whether it could be pressed), and
 *   `seconds` since the page opened.
 * - `create_ready`, once, as the Create button can first be pressed: `seconds`.
 * - `create_pressed_unready`, a press on the Create button while it can't be pressed: `missing`,
 *   what stood in the way, in the page's order and comma-separated (`play`, `size`, `name`, `plan`
 *   for a choice another plan runs, `check` for a choice that couldn't be checked).
 * - `create_left`, leaving without a server: `last_step` (`opened`, `play`, `size`, `name`,
 *   `pressed`), the furthest it got, and `seconds` on the page; `presses`, how many buttons,
 *   links and fields were pressed, `typed`, whether anything was typed, `ready`, whether the
 *   Create button could be pressed as they left, and `furthest_seen` (`play`, `size`, `name`), the
 *   furthest part that came into view.
 *
 * None of it is personal: no name, no address, nothing typed, and PostHog runs cookieless
 * (lib/insight.tsx). The page's own state says what was chosen, and `watching.ts` hears the rest
 * on the page; this only reports it.
 */
import type { PartySize, SetupPreview, SetupSourceInput } from '@blockly/contracts'
import { SECOND_MS } from '@blockly/contracts/durations'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { codeOf, useTRPC } from '../../../../lib/api'
import { asCode, capture, type Said } from '../../../../lib/insight'
import { keptChoice } from './kept'
import { usePlanLimit } from './limit'
import { unanswered, type useCreate } from './sending'
import { useWatched } from './watching'

/** The events, by what they report. Their names are a contract with the analytics built on them. */
export const CREATE_EVENTS = {
  opened: 'create_opened',
  chose: 'create_chose',
  blocked: 'create_blocked',
  pressed: 'create_pressed',
  done: 'create_done',
  refused: 'create_refused',
  left: 'create_left',
  acted: 'create_acted',
  seen: 'create_seen',
  ready: 'create_ready',
  unready: 'create_pressed_unready',
} as const

/** The presses `create_acted` names, each marked where it is drawn with `createMark`. */
const ACTS = [
  'more_opened',
  'more_closed',
  'packs_opened',
  'upload_opened',
  'ways_back',
  'pack_pressed',
  'server_types_opened',
] as const
type Act = (typeof ACTS)[number]

/** The mark that reports a press of this control as `create_acted`. */
export const createMark = (act: Act) => ({ 'data-create': act })

/** The parts of the page `create_seen` names, in the page's order; the bar's button is apart. */
const PARTS = ['play', 'size', 'name'] as const
type Seen = (typeof PARTS)[number] | 'button'

/** What stands in the way of the Create button, as `create_pressed_unready` says it. */
type Missing = 'play' | 'size' | 'name' | 'plan' | 'check'

type CreateEvent = (typeof CREATE_EVENTS)[keyof typeof CREATE_EVENTS]

/** How a view sends an event: `capture`, or a stand-in in the tests. */
type Send = (event: CreateEvent, properties: Said, leaving?: boolean) => void

/** How the page opened, as `create_opened` carries it. */
interface Opened {
  first_server?: boolean | undefined
  source?: 'copy' | 'replace' | SetupSourceInput['kind'] | undefined
  key?: string | undefined
}

/** A choice, as `create_chose` carries it. */
type Chosen =
  | { field: 'play'; kind: SetupSourceInput['kind']; key?: string }
  | { field: 'version'; value: string }
  | { field: 'region'; value: string }
  | { field: 'size'; value: PartySize }
  | { field: 'name'; filled: boolean }
  | { field: 'for_a_day'; on: boolean }

type Field = Chosen['field']

/** How far a view got, in the page's order. */
const STEPS = ['opened', 'play', 'size', 'name', 'pressed'] as const
type Step = (typeof STEPS)[number]

/** The step each field belongs to; where it runs is in the bar, not a step. */
const STEP_OF: Record<Field, Step | null> = {
  play: 'play',
  version: 'play',
  region: null,
  size: 'size',
  name: 'name',
  for_a_day: 'name',
}

/** How long a field stays unchanged before its choice counts: a pass through the options is one. */
const SETTLE_MS = SECOND_MS

/**
 * What a view does besides choosing: its presses and typing, the parts it reaches, when the
 * Create button can be pressed, and presses on it while it can't. Nothing once the view has ended.
 */
function createLooks(send: Send, seconds: () => number, ended: () => boolean) {
  let presses = 0
  let typed = false
  let ready = false
  let readySent = false
  let furthest = 0
  const seen = new Set<Seen>()
  return {
    /** A button, link or field was pressed. */
    touched() {
      presses += 1
    },
    /** Something was typed: never what. */
    typed() {
      typed = true
    },
    /** A marked press; anything not listed in `ACTS` says nothing. */
    acted(action: string | undefined) {
      const act = ACTS.find((one) => one === action)
      if (act !== undefined && !ended()) send(CREATE_EVENTS.acted, { action: act })
    },
    /** A part of the page came into view; `buttonReady`, whether the Create button can be pressed. */
    seen(what: Seen, buttonReady: boolean) {
      if (seen.has(what) || ended()) return
      seen.add(what)
      if (what !== 'button') furthest = Math.max(furthest, PARTS.indexOf(what))
      send(CREATE_EVENTS.seen, {
        what,
        seconds: seconds(),
        ...(what === 'button' ? { ready: buttonReady } : {}),
      })
    },
    /** Whether the Create button can be pressed now; the first time it can is reported. */
    ready(now: boolean) {
      ready = now
      if (!now || readySent || ended()) return
      readySent = true
      send(CREATE_EVENTS.ready, { seconds: seconds() })
    },
    /** A press on the Create button while it can't be pressed, and what stood in the way. */
    unready(missing: readonly Missing[]) {
      if (missing.length > 0 && !ended()) send(CREATE_EVENTS.unready, { missing: missing.join(',') })
    },
    /** What `create_left` adds about the view. */
    summary(): Said {
      return { presses, typed, ready, furthest_seen: PARTS[furthest] ?? 'play' }
    },
  }
}

/**
 * One view's reporter. A choice waits `settleMs` for its field to settle, and is sent only when it
 * differs from the last one sent for that field; pressing or leaving sends what waits first.
 */
export function createSteps(send: Send, now: () => number = Date.now, settleMs = SETTLE_MS) {
  const since = now()
  let furthest = 0
  let ended = false
  let opened = false
  const waiting = new Map<Field, { chosen: Chosen; timer: ReturnType<typeof setTimeout> }>()
  const sent = new Map<Field, string>()
  let shown = new Set<string>()
  const seconds = () => Math.round((now() - since) / SECOND_MS)
  const looks = createLooks(send, seconds, () => ended)
  const settle = (field: Field) => {
    const chosen = waiting.get(field)?.chosen
    if (chosen === undefined) return
    clearTimeout(waiting.get(field)?.timer)
    waiting.delete(field)
    const said = JSON.stringify(chosen)
    if (sent.get(field) === said) return
    sent.set(field, said)
    send(CREATE_EVENTS.chose, chosen)
  }
  const settleAll = () => {
    for (const field of [...waiting.keys()]) settle(field)
  }
  return {
    ...looks,
    opened(at: Opened) {
      if (opened || ended) return
      opened = true
      const said: Said = {}
      for (const [key, value] of Object.entries(at)) if (value !== undefined) said[key] = value
      send(CREATE_EVENTS.opened, said)
    },
    /** A choice the page opened with: counted as the field's, not as one made here. */
    known(chosen: Chosen) {
      sent.set(chosen.field, JSON.stringify(chosen))
    },
    chose(chosen: Chosen) {
      if (ended) return
      const step = STEP_OF[chosen.field]
      if (step !== null) furthest = Math.max(furthest, STEPS.indexOf(step))
      clearTimeout(waiting.get(chosen.field)?.timer)
      waiting.set(chosen.field, { chosen, timer: setTimeout(() => settle(chosen.field), settleMs) })
    },
    /** The reasons the page shows now; each is sent as it appears. */
    blocked(reasons: readonly string[]) {
      const current = new Set(reasons.map(asCode))
      for (const reason of current) if (!shown.has(reason) && !ended) send(CREATE_EVENTS.blocked, { reason })
      shown = current
    },
    pressed() {
      if (ended) return
      settleAll()
      furthest = STEPS.indexOf('pressed')
      send(CREATE_EVENTS.pressed, {})
    },
    done() {
      if (ended) return
      settleAll()
      ended = true
      send(CREATE_EVENTS.done, { seconds: seconds() })
    },
    refused(code: string) {
      if (!ended) send(CREATE_EVENTS.refused, { code: asCode(code) })
    },
    /** The page is going away without a server: once, whatever calls it. */
    left() {
      if (ended) return
      settleAll()
      ended = true
      const last_step = STEPS[furthest] ?? 'opened'
      send(CREATE_EVENTS.left, { last_step, seconds: seconds(), ...looks.summary() }, true)
    },
  }
}

/** What the page is showing, as far as reporting it goes. */
interface View {
  from: SetupSourceInput | null
  partySize: PartySize | null
  /** The region picked by hand; null while it is Cubepals' pick. */
  region: string | null
  name: string
  temporary: boolean | null
  preview: { data?: SetupPreview | undefined; error: unknown }
  refused: unknown
  create: Pick<ReturnType<typeof useCreate>, 'submittedAt' | 'isSuccess' | 'error'>
}

/** The fields the view has an answer for, as `create_chose` would say each. */
export function choicesOf(view: Pick<View, 'from' | 'partySize' | 'region' | 'name' | 'temporary'>) {
  const { from } = view
  const key = from === null ? undefined : keyOf(from)
  const choices: Chosen[] = [{ field: 'name', filled: view.name.trim() !== '' }]
  if (from !== null) choices.push({ field: 'play', kind: from.kind, ...(key === undefined ? {} : { key }) })
  if (from?.kind === 'template' && from.gameVersion !== undefined)
    choices.push({ field: 'version', value: from.gameVersion })
  if (view.partySize !== null) choices.push({ field: 'size', value: view.partySize })
  if (view.region !== null) choices.push({ field: 'region', value: view.region })
  if (view.temporary !== null) choices.push({ field: 'for_a_day', on: view.temporary })
  return choices
}

/**
 * What stands in the way of the Create button, by the page's own rule for it (`ready` in
 * page.tsx): what to play, who is playing (`sized`: answered, or settled by the plan where it
 * isn't asked), the name, a choice another plan runs, and a choice that couldn't be checked.
 * None: it can be pressed.
 */
export function missingOf(view: Pick<View, 'from' | 'name' | 'preview'>, sized: boolean): Missing[] {
  const missing: Missing[] = []
  if (view.from === null) missing.push('play')
  if (!sized) missing.push('size')
  if (view.name.trim() === '') missing.push('name')
  if (view.from !== null && view.preview.data?.size.allowed === false) missing.push('plan')
  if (view.preview.error != null) missing.push('check')
  return missing
}

/** The reasons a server can't be made that the view shows, as codes. */
function reasonsOf(view: View, limitCode: string | null): string[] {
  const size = view.from === null ? undefined : view.preview.data?.size
  return [
    limitCode,
    size?.allowed === false ? (size.plan == null ? 'size_not_allowed' : 'size_needs_plan') : null,
    view.preview.error == null ? null : (codeOf(view.preview.error) ?? 'preview_failed'),
    view.refused === null ? null : 'pick_refused',
  ].filter((reason) => reason !== null)
}

/**
 * Reports the create page's view: how it opened, each choice as it settles, what stood in the way,
 * the press and its answer, what was done on the page meanwhile (`watching.ts`, on the form this
 * returns the ref for), and `create_left` as the page goes (closed, reloaded or navigated away
 * from). Development's double mount comes straight back, so leaving waits a tick.
 */
export function useSteps(view: View): (form: HTMLFormElement | null) => void {
  const trpc = useTRPC()
  const search = useSearchParams()
  const overview = useQuery(trpc.account.overview.queryOptions())
  const options = useQuery(trpc.servers.createOptions.queryOptions())
  const limit = usePlanLimit(search.get('replace'))
  const [steps] = useState(() => createSteps(capture))
  // Who is playing is asked only where the plan sells more than one size; else the one it sells.
  const sizes = options.data?.partySizes.filter((size) => size.allowed).length ?? 0
  const asksSize = sizes > 1
  const missing = missingOf(view, asksSize ? view.partySize !== null : sizes === 1)
  const form = useWatched(steps, missing, asksSize)
  const seen = useRef<Map<Field, string> | null>(null)
  const leaving = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    clearTimeout(leaving.current)
    const leave = () => steps.left()
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      leaving.current = setTimeout(leave, 0)
    }
  }, [steps])

  const known = overview.data?.usage.servers
  const settled = !overview.isPending
  useEffect(() => {
    if (settled)
      steps.opened({ first_server: known === undefined ? undefined : known === 0, ...openedWith(search) })
  }, [steps, settled, known, search])

  const choices = JSON.stringify(choicesOf(view))
  useEffect(() => {
    const first = seen.current === null
    seen.current ??= new Map()
    for (const chosen of JSON.parse(choices) as Chosen[]) {
      const said = JSON.stringify(chosen)
      if (seen.current.get(chosen.field) === said) continue
      seen.current.set(chosen.field, said)
      if (first) steps.known(chosen)
      else steps.chose(chosen)
    }
  }, [steps, choices])

  const reasons = reasonsOf(view, limit.atLimit === null ? null : (limit.limitCode ?? 'at_limit')).join(' ')
  useEffect(() => steps.blocked(reasons === '' ? [] : reasons.split(' ')), [steps, reasons])

  const { submittedAt, isSuccess, error } = view.create
  useEffect(() => {
    if (submittedAt > 0) steps.pressed()
  }, [steps, submittedAt])
  useEffect(() => {
    if (isSuccess) steps.done()
    else if (error !== null) steps.refused(unanswered(error) ? 'unanswered' : (codeOf(error) ?? 'other'))
  }, [steps, isSuccess, error])

  const ready = missing.length === 0
  useEffect(() => steps.ready(ready), [steps, ready])
  return form
}

/**
 * Reports a pack search once its answer is in (`pack_searched`, how many came back) and a pasted
 * link once it is read (`pack_linked`, whether it was a pack). What was typed is only how a new
 * search is told from the last one, here; it is never sent.
 */
export function useSearchSteps(
  search: {
    /** Whether the words are a search: long enough, and not a link. */
    on: boolean
    words: string
    answer: { data?: readonly unknown[] | undefined; isPlaceholderData: boolean }
  },
  link: { address: string | null; answer: { data?: { kind: string } | undefined } },
): void {
  const searched = useRef<string | null>(null)
  const words = search.on ? search.words : null
  const results = search.answer.isPlaceholderData ? undefined : search.answer.data?.length
  useEffect(() => {
    if (words === null || results === undefined || searched.current === words) return
    searched.current = words
    capture(CREATE_EVENTS.acted, { action: 'pack_searched', results })
  }, [words, results])
  const linked = useRef<string | null>(null)
  const kind = link.answer.data?.kind
  useEffect(() => {
    if (link.address === null || kind === undefined || linked.current === link.address) return
    linked.current = link.address
    capture(CREATE_EVENTS.acted, { action: 'pack_linked', found: kind === 'pack' })
  }, [link.address, kind])
}

/** Where the page opened with a choice made: a copy, a replacement, or one carried back from paying. */
function openedWith(search: { get(name: string): string | null }): Opened {
  if (search.get('like') !== null) return { source: 'copy' }
  if (search.get('replace') !== null) return { source: 'replace' }
  const from = keptChoice(search).from
  return from === null ? {} : { source: from.kind, key: keyOf(from) }
}

/** The template's or pack's key a way to play names; none for an upload or a copy. */
function keyOf(from: SetupSourceInput): string | undefined {
  if (from.kind === 'template' || from.kind === 'curated') return from.key
  return from.kind === 'modpack' ? from.projectId : undefined
}
