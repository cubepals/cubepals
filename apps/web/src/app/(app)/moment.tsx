// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The good-moment card: "How's it going?" after something control noticed, in the corner of the
 * app. When to ask is control's to decide; this asks once as the app opens and shows the answer.
 */
import type { MomentAskView } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useTRPC } from '../../lib/api'
import { APP_VERSION, insightOn } from '../../lib/insight'
import { noticed } from '../../lib/moments'
import { Button } from '../../ui'
import styles from './insight.module.css'

/** Pages where someone is making a server or paying: the question waits for another visit. */
const busy = (page: string) => page.startsWith('/servers/new') || page.startsWith('/checkout')

/**
 * "How's it going?", once, after a good moment control noticed (a friend joined, a server woke
 * for a player, a second week of play), in a small card in the bottom corner. Asked when the app
 * opens, never on a page where someone is making a server or paying, at most once a fortnight
 * (control decides). Good or Not great, an optional line, and done; closing it is final for that
 * moment.
 */
export function MomentCard() {
  const trpc = useTRPC()
  const page = usePathname()
  const [ask, setAsk] = useState<MomentAskView | null>(null)
  const [rating, setRating] = useState<'Good' | 'Not great' | null>(null)
  const [text, setText] = useState('')
  const [done, setDone] = useState(false)
  const question = useMutation(trpc.insight.moment.mutationOptions({ onSuccess: setAsk }))
  const answer = useMutation(trpc.insight.answerMoment.mutationOptions({ onSuccess: () => setDone(true) }))
  const dismiss = useMutation(trpc.insight.dismissMoment.mutationOptions())
  // Once as the app opens: where it opens is what decides whether now is a good time.
  const asked = useRef(false)
  useEffect(() => {
    if (!insightOn || asked.current) return
    asked.current = true
    question.mutate({ busy: busy(page) })
  }, [page, question])
  // The thanks stays a moment, then the card goes.
  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setAsk(null), 2_500)
    return () => clearTimeout(timer)
  }, [done])

  if (ask === null) return null
  const close = () => {
    if (!done) dismiss.mutate({ moment: ask.moment })
    setAsk(null)
  }
  return (
    <section className={styles.moment} aria-label="How’s it going?">
      <div className={styles.head}>
        <p className="type-body-sm" style={{ margin: 0 }}>
          {done ? 'Thanks. It went straight to the person building this.' : `${noticed(ask)} How’s it going?`}
        </p>
        <button type="button" className={styles.close} aria-label="Close" onClick={close}>
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {!done && (
        <>
          <fieldset className={styles.choices} aria-label="How’s it going?">
            {(['Good', 'Not great'] as const).map((choice) => (
              <Button
                key={choice}
                size="sm"
                variant={rating === choice ? 'primary' : 'outline'}
                aria-pressed={rating === choice}
                onClick={() => setRating(choice)}
              >
                {choice}
              </Button>
            ))}
          </fieldset>
          {rating !== null && (
            <form
              className="bk-stack"
              style={{ gap: 'var(--space-8)' }}
              onSubmit={(event) => {
                event.preventDefault()
                answer.mutate({
                  moment: ask.moment,
                  rating,
                  text: text.trim(),
                  page,
                  version: APP_VERSION,
                })
              }}
            >
              <label className="bk-field">
                <span className="bk-field__label">
                  Anything to add? <span className="bk-field__optional">(optional)</span>
                </span>
                <textarea
                  className="bk-input"
                  rows={2}
                  maxLength={2000}
                  dir="auto"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
              {answer.isError && (
                <p className="bk-field__error" role="alert">
                  That didn’t send. Try again in a moment.
                </p>
              )}
              <Button type="submit" size="sm" variant="primary" disabled={answer.isPending}>
                {answer.isPending ? 'Sending…' : 'Send'}
              </Button>
            </form>
          )}
        </>
      )}
    </section>
  )
}
