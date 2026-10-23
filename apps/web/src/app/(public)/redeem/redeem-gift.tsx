// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * The code, filled in from the gift email's link, and the one button that redeems it. Signed out,
 * the person signs in or makes an account first and comes back here with the code still filled
 * in. Redeemed, it says what they have and until when.
 *
 * The field writes the code the way the email does as it is typed or pasted (`code-typing.ts`), so
 * a wrong one is hard to type, and says how much is left until it is whole.
 */

import { type RedeemedGiftView, readCode } from '@blockly/contracts'
import { MINUTE_MS } from '@blockly/contracts/durations'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { type SubmitEvent, Suspense, useLayoutEffect, useRef, useState } from 'react'
import { messageOf, useTRPC } from '../../../lib/api'
import { behindSignIn, behindSignUp, useSignedIn } from '../../../lib/viewer'
import { Button, Note, Skeleton, TextField } from '../../../ui'
import { arrived, type CodeText, deletion, pasted, remaining, typed } from './code-typing'

export function RedeemGift() {
  return (
    <Suspense fallback={<Skeleton width={240} height={36} />}>
      <Redeem />
    </Suspense>
  )
}

function Redeem() {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const signedIn = useSignedIn()
  const linked = useSearchParams().get('code') ?? ''
  const [text, setText] = useState<CodeText>(() => ({ value: arrived(linked), caret: 0 }))
  const field = useRef<HTMLInputElement>(null)
  const redeem = useMutation(
    trpc.gifts.redeem.mutationOptions({ onSuccess: () => queries.invalidateQueries() }),
  )
  // The caret goes where the person expects it once the dashes are written back.
  useLayoutEffect(() => {
    const input = field.current
    if (input && input === document.activeElement) input.setSelectionRange(text.caret, text.caret)
  }, [text])
  if (redeem.data) return <Redeemed gift={redeem.data} />
  const code = text.value
  const whole = readCode(code) !== null
  const change = (next: CodeText) => {
    setText(next)
    // A refusal was about the code as it was; it goes once the code changes.
    if (next.value !== code) redeem.reset()
  }
  const back = `/redeem${code ? `?code=${encodeURIComponent(code)}` : ''}`
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (signedIn && whole && !redeem.isPending) redeem.mutate({ code })
  }
  return (
    <form className="bk-stack" style={{ gap: 'var(--space-16)' }} onSubmit={submit}>
      <TextField
        ref={field}
        label="Gift code"
        mono
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="XXXX-XXXX-XXXX-XXXX"
        value={code}
        onChange={(event) => {
          const input = event.target
          const deleting = deletion((event.nativeEvent as InputEvent).inputType ?? '')
          change(typed(text, input.value, input.selectionStart ?? input.value.length, deleting))
        }}
        onPaste={(event) => {
          event.preventDefault()
          const input = event.currentTarget
          const start = input.selectionStart ?? code.length
          change(pasted(text, start, input.selectionEnd ?? start, event.clipboardData.getData('text')))
        }}
        help={remaining(code)}
        live
        error={redeem.isError ? messageOf(redeem.error) : undefined}
      />
      {signedIn ? (
        <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
          <Button variant="primary" size="lg" type="submit" disabled={redeem.isPending || !whole}>
            {redeem.isPending ? 'Redeeming…' : 'Redeem'}
          </Button>
        </div>
      ) : (
        <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
          <Button variant="primary" size="lg" href={behindSignUp(false, back)}>
            Make an account to redeem it
          </Button>
          <Button variant="ghost" size="lg" href={behindSignIn(false, back)}>
            Sign in
          </Button>
        </div>
      )}
    </form>
  )
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

function Redeemed({ gift }: { gift: RedeemedGiftView }) {
  const name = `${gift.planKey[0]?.toUpperCase() ?? ''}${gift.planKey.slice(1)}`
  const later = new Date(gift.startsAt).getTime() > Date.now() + MINUTE_MS
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-16)' }}>
      <Note tone="success">
        {later
          ? `It’s yours. It starts on ${DAY.format(new Date(gift.startsAt))}, when the ${name} you have now ends, and runs until ${DAY.format(new Date(gift.endsAt))}.`
          : `It’s yours. You have ${name} until ${DAY.format(new Date(gift.endsAt))}.`}
      </Note>
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
        <Button variant="primary" size="lg" href="/servers">
          Go to your servers
        </Button>
      </div>
    </div>
  )
}
