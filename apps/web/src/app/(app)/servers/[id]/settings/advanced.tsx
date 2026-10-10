// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { ServerView, SettingsOptions } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useTRPC } from '../../../../../lib/api'
import { type Outcome, useOutcome } from '../../../../../lib/outcome'
import { runsOnPaper } from '../../../../../lib/present'
import { Card, FormRow, Toggle } from '../../../../../ui'
import { ConfirmChange, changeable, useChanged, whatHappens } from './shared'

/**
 * What almost nobody needs, closed until someone opens it: whether the server checks players with
 * Minecraft's account servers (§15.1), and, for plain Minecraft, whether it runs on Paper or on
 * Mojang's own server.
 */
export function Advanced({ view, options }: { view: ServerView; options: SettingsOptions | undefined }) {
  // Above the switch, which starts over once the change lands: "Saved" outlives that.
  const outcome = useOutcome(view)
  const paperOffered = (options?.gameVersions.find((v) => v.value === view.gameVersion)?.loaders ?? []).some(
    (l) => l.value === 'paper' && l.allowed,
  )
  return (
    <details style={{ maxWidth: 'var(--width-form)' }}>
      <summary className="type-body-sm bk-disclosure">Advanced</summary>
      <div className="bk-grid" style={{ marginBlockStart: 'var(--space-16)', gap: 'var(--space-16)' }}>
        <Card>
          <OnlineAuthentication key={String(view.settings.onlineMode)} view={view} outcome={outcome} />
        </Card>
        {view.loader === 'vanilla' && (runsOnPaper(view) || paperOffered) && (
          <Card>
            <ServerSoftware key={String(runsOnPaper(view))} view={view} outcome={outcome} />
          </Card>
        )}
      </div>
    </details>
  )
}

/**
 * The way back from what Cubepals decided for a plain server: Paper, which plays the same and keeps
 * up with more players, or Mojang's own server, exactly as it comes. Either way the world comes along.
 */
function ServerSoftware({ view, outcome }: { view: ServerView; outcome: Outcome }) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const [asking, setAsking] = useState(false)
  const save = useMutation(
    trpc.servers.changeVersion.mutationOptions({
      onSuccess: (next) => {
        setAsking(false)
        changed(next)
        outcome.settled(next)
      },
    }),
  )
  const on = runsOnPaper(view)
  const allowed = changeable(view)
  const now = on
    ? 'On. Cubepals runs Minecraft on Paper: the same game, with less lag.'
    : 'Off. Mojang’s own server, exactly as it comes.'
  return (
    <>
      <FormRow
        label="Run on Paper"
        description={allowed.busy !== undefined ? `${allowed.busy}…` : now}
        control={
          <Toggle
            checked={on}
            ariaLabel="Run on Paper"
            disabled={!allowed.ok}
            onChange={() => setAsking(true)}
          />
        }
      />
      <ConfirmChange
        open={asking}
        onClose={() => setAsking(false)}
        title={on ? 'Run Mojang’s own server?' : 'Run on Paper?'}
        cancelLabel={on ? 'Stay on Paper' : 'Keep Mojang’s server'}
        confirmLabel={on ? 'Switch to Mojang’s server' : 'Switch to Paper'}
        working="Switching"
        error={save.error}
        onConfirm={(requestId) =>
          save.mutateAsync({
            serverId: view.id,
            requestId,
            version: view.version,
            gameVersion: view.gameVersion,
            loader: 'vanilla',
            onPaper: !on,
            expected: [],
          })
        }
      >
        {on ? (
          <p>
            Minecraft plays the same, exactly as Mojang ships it. Paper keeps up better when many people play
            or explore at once; you can switch back here any time.
          </p>
        ) : (
          <p>
            Paper plays the same game and keeps up with more players. A few redstone and farm tricks that rely
            on Minecraft’s bugs work differently on it.
          </p>
        )}
        <p>Your world comes along, its Nether and End too.</p>
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {whatHappens(view)}
        </p>
      </ConfirmChange>
    </>
  )
}

/**
 * Asked once either way, because it changes who each name is to the server: what happens is said
 * plainly, and nothing more is asked.
 */
function OnlineAuthentication({ view, outcome }: { view: ServerView; outcome: Outcome }) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const [asking, setAsking] = useState(false)
  const save = useMutation(
    trpc.servers.changeAuthentication.mutationOptions({
      onSuccess: (next) => {
        setAsking(false)
        changed(next)
        outcome.settled(next)
      },
    }),
  )
  const on = view.settings.onlineMode
  const allowed = changeable(view)
  const now = on
    ? 'On by default. Verify players with Minecraft’s account servers.'
    : 'Off. Players aren’t verified with Minecraft’s account servers.'

  return (
    <>
      <FormRow
        label="Online authentication"
        description={
          allowed.busy !== undefined
            ? `${allowed.busy}…`
            : outcome.said === 'done'
              ? `Saved. ${now}`
              : outcome.said === 'failed'
                ? `Didn’t change. ${now}`
                : now
        }
        control={
          <Toggle
            checked={on}
            ariaLabel="Online authentication"
            disabled={!allowed.ok}
            onChange={() => setAsking(true)}
          />
        }
      />
      <ConfirmChange
        open={asking}
        onClose={() => setAsking(false)}
        title={on ? 'Turn off online authentication?' : 'Turn on online authentication?'}
        cancelLabel={on ? 'Keep it on' : 'Keep it off'}
        confirmLabel={on ? 'Turn it off' : 'Turn it on'}
        tone={on ? 'danger' : 'primary'}
        working={on ? 'Turning it off' : 'Turning it on'}
        error={save.error}
        onConfirm={(requestId) =>
          save.mutateAsync({ serverId: view.id, requestId, version: view.version, onlineMode: !on })
        }
      >
        {on ? (
          <>
            <p>
              Players will no longer be verified with Minecraft’s account servers, so someone can join using
              another player’s name, an operator’s included. Only turn it off if you understand what that
              means for your server.
            </p>
            <p>
              Everyone who has played here starts over: what they had, where they were and their progress, in
              mods too, stay with their account and come back if you turn this on again.
            </p>
          </>
        ) : (
          <>
            <p>Players are verified again, so everyone needs their own Minecraft account to join.</p>
            <p>
              Everyone picks up where they were before it was turned off. What they did since stays with the
              names they used, and comes back if you turn it off again.
            </p>
          </>
        )}
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {whatHappens(view)}
        </p>
      </ConfirmChange>
    </>
  )
}
