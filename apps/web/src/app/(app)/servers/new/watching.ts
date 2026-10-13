// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * What the create page's form hears that its state doesn't say: presses of its buttons, links
 * and fields, typing, the presses marked with `createMark`, each part of the page as it first
 * comes into view, and a press on the Create button while it can't be pressed. It reads no text
 * and no element but those marks, the parts and the button, and it reports nothing itself: it
 * hands each to the view's reporter (`steps.ts`), which says what is sent.
 */
import { useEffect, useRef, useState } from 'react'

/** What it hands on, as the view's reporter takes it (`createSteps` in steps.ts). */
interface Heard<Missing> {
  touched(): void
  typed(): void
  acted(action: string | undefined): void
  seen(what: 'play' | 'size' | 'name' | 'button', buttonReady: boolean): void
  unready(missing: readonly Missing[]): void
}

/** What counts as a press: a control someone acts on. A label hands its press on to its field. */
const CONTROLS = 'button, a, summary, select, input, textarea'

/** The fields where what is pressed is typed, not chosen. */
const TYPED = new Set(['text', 'search', 'email', 'url'])

/**
 * Watches the form the returned ref is given. `missing` is what stands in the way of the Create
 * button now (`missingOf`), said with a press on it while it can't be pressed; `asksSize`, whether
 * the page has a part for who is playing, which it knows only once its options are in.
 */
export function useWatched<Missing>(heard: Heard<Missing>, missing: readonly Missing[], asksSize: boolean) {
  const [form, setForm] = useState<HTMLFormElement | null>(null)
  const lacking = useRef(missing)
  lacking.current = missing

  useEffect(() => {
    if (form === null) return
    const button = () => form.querySelector<HTMLButtonElement>('button[type="submit"]')
    const clicked = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(CONTROLS)) heard.touched()
      const marked = target?.closest<HTMLElement>('[data-create]')
      if (marked) heard.acted(marked.dataset.create)
    }
    const typed = (event: Event) => {
      const field = event.target
      if (
        field instanceof HTMLTextAreaElement ||
        (field instanceof HTMLInputElement && TYPED.has(field.type))
      )
        heard.typed()
    }
    // A button that can't be pressed takes no press, and lets it through to the bar under it, so a
    // press is told by where it lands.
    const pointed = (event: PointerEvent) => {
      const at = button()
      if (at === null || !at.disabled) return
      const box = at.getBoundingClientRect()
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom
      if (!inside) return
      heard.touched()
      heard.unready(lacking.current)
    }
    form.addEventListener('click', clicked)
    form.addEventListener('input', typed)
    form.addEventListener('pointerdown', pointed)
    const stopLooking = watchParts(form, heard, button, asksSize)
    return () => {
      form.removeEventListener('click', clicked)
      form.removeEventListener('input', typed)
      form.removeEventListener('pointerdown', pointed)
      stopLooking()
    }
  }, [form, heard, asksSize])

  return setForm
}

/**
 * Sees each part of the page (`Part`, marked `data-part`) and the Create button come into view;
 * stops when called. The parts are in the page's order: what to play, who is playing where the
 * page asks it (`asksSize`), and the name. A part counts once it is above the bottom fifth of the
 * screen, where the bar would cover it; the button, in that bar, as soon as it shows.
 */
function watchParts(
  form: HTMLFormElement,
  heard: Pick<Heard<unknown>, 'seen'>,
  button: () => HTMLButtonElement | null,
  asksSize: boolean,
): () => void {
  const parts = [...form.querySelectorAll('[data-part]')]
  const names = asksSize ? (['play', 'size', 'name'] as const) : (['play', 'name'] as const)
  const nameOf = (part: Element) => names[parts.indexOf(part)] ?? 'name'
  const ready = () => button()?.disabled === false
  const shown =
    (name: (target: Element) => 'play' | 'size' | 'name' | 'button') =>
    (entries: IntersectionObserverEntry[]) => {
      for (const entry of entries) if (entry.isIntersecting) heard.seen(name(entry.target), ready())
    }
  const reading = new IntersectionObserver(shown(nameOf), { rootMargin: '0px 0px -20% 0px' })
  for (const part of parts) reading.observe(part)
  const pressing = new IntersectionObserver(shown(() => 'button'))
  const submit = button()
  if (submit !== null) pressing.observe(submit)
  return () => {
    reading.disconnect()
    pressing.disconnect()
  }
}
