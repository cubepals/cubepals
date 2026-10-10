// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { Mail } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { EmptyState } from '../../../ui'
import { ResendConfirmation } from '../resend-confirmation'

export default function CheckEmailPage() {
  return (
    <Suspense>
      <CheckEmail />
    </Suspense>
  )
}

function CheckEmail() {
  const email = useSearchParams().get('email')
  return (
    <EmptyState
      art={<Mail size={48} strokeWidth={1.5} color="var(--forest-ink)" aria-hidden />}
      title="Check your email"
      description={
        email
          ? `We sent a link to ${email}. Open it to confirm your account, and you can create your first server.`
          : 'We sent you a link. Open it to confirm your account, and you can create your first server.'
      }
      action={
        email && (
          <p className="type-body-sm">
            <ResendConfirmation email={email} prompt="Nothing yet?" label="Send it again" />
          </p>
        )
      }
    />
  )
}
