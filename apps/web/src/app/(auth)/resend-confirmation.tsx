// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useState } from 'react'
import { authClient } from '../../lib/auth'

/**
 * A new confirmation link, for an account that hasn't confirmed its email. Links work for an hour,
 * so without this an old one would leave the account unable to create servers.
 */
export function ResendConfirmation({
  email,
  prompt,
  label = 'Send a new link',
}: {
  email: string
  /** Words before the button, dropped once the link is sent. */
  prompt?: string
  label?: string
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')

  const send = async () => {
    setState('sending')
    const { error } = await authClient.sendVerificationEmail({ email, callbackURL: '/servers/new' })
    setState(error ? 'failed' : 'sent')
  }

  if (state === 'sent') return <span>Sent. The new link works for an hour.</span>
  return (
    <>
      {prompt && `${prompt} `}
      <button type="button" className="bk-linkbutton" disabled={state === 'sending'} onClick={send}>
        {state === 'sending' ? 'Sending…' : label}
      </button>
      {state === 'failed' && <span> We could not send it just now. Try again in a minute.</span>}
    </>
  )
}
