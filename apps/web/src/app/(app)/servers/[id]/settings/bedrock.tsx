// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Whether Bedrock players (phones, tablets and Windows) can join a server, and how they do. On a
 * Paper server it is on, and this is the switch that takes it away with what Cubepals added for it;
 * on any other server type it says they can't yet, and where they can. Beside Other versions, and
 * with the same restart.
 */

import type { ServerView } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useTRPC } from '../../../../../lib/api'
import { useOutcome } from '../../../../../lib/outcome'
import { Button, FormRow, FormSection, Toggle } from '../../../../../ui'
import { ConfirmChange, changeable, useChanged, whatHappens } from './shared'

/** The port Bedrock players type beside the address, which is Bedrock's own default. */
const BEDROCK_PORT = 19132

export function BedrockSetting({ view }: { view: ServerView }) {
  if (view.bedrock === null)
    return (
      <FormSection
        title="Bedrock friends"
        description="Phones, tablets and Windows can’t join this kind of server yet. They can join a Paper server."
      >
        <Button variant="secondary" href="/servers/new">
          Make a Paper server
        </Button>
      </FormSection>
    )
  return <BedrockForm key={String(view.bedrock)} view={view} on={view.bedrock} />
}

function BedrockForm({ view, on }: { view: ServerView; on: boolean }) {
  const trpc = useTRPC()
  const outcome = useOutcome(view)
  const changed = useChanged(view.id)
  const [asking, setAsking] = useState<boolean | null>(null)
  const save = useMutation(
    trpc.servers.changeBedrock.mutationOptions({
      onSuccess: (next) => {
        setAsking(null)
        changed(next)
        outcome.settled(next)
      },
    }),
  )
  const allowed = changeable(view)
  const line = on
    ? 'Bedrock friends can join: phones, tablets and Windows.'
    : 'Bedrock friends can’t join: phones, tablets and Windows.'
  const said =
    allowed.busy !== undefined
      ? `${allowed.busy}…`
      : outcome.said === 'done'
        ? `Saved. ${line}`
        : outcome.said === 'failed'
          ? `Didn’t change. ${line}`
          : line

  return (
    <FormSection title="Bedrock friends" description={said}>
      <FormRow
        label="Let Bedrock players join"
        description="Cubepals adds what they need when the server starts, and takes it away if you switch this off."
        control={
          <Toggle
            checked={on}
            ariaLabel="Let Bedrock players join"
            disabled={!allowed.ok}
            onChange={() => setAsking(!on)}
          />
        }
      />
      {on && (
        <>
          <p className="bk-field__help">
            On a phone or tablet: Play, Servers, Add Server. Type {view.joinAddress} as the address and{' '}
            {BEDROCK_PORT} as the port.
          </p>
          <p className="bk-field__help">
            Xbox, PlayStation and Switch can’t add a server, so they can’t join.
          </p>
        </>
      )}
      <ConfirmChange
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={asking === false ? 'Stop Bedrock players joining?' : 'Let Bedrock players join?'}
        confirmLabel={asking === false ? 'Stop them joining' : 'Let them join'}
        working="Saving your change"
        error={save.error}
        onConfirm={(requestId) =>
          save.mutateAsync({ serverId: view.id, requestId, version: view.version, bedrock: asking ?? on })
        }
      >
        <p>
          {asking === false
            ? 'Players on Bedrock won’t be able to join. Java players are not affected.'
            : 'Players on phones, tablets and Windows can join with the same address.'}
        </p>
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {whatHappens(view)}
        </p>
      </ConfirmChange>
    </FormSection>
  )
}
