// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { SERVER_ICONS, type ServerIcon, type ServerView } from '@blockly/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import Image from 'next/image'
import { type SubmitEvent, useState } from 'react'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { useDebounced } from '../../../../../lib/hooks'
import { type Outcome, said, useOutcome } from '../../../../../lib/outcome'
import { iconSrc } from '../../../../../lib/present'
import * as rules from '../../../../../lib/rules'
import { useChecked } from '../../../../../lib/use-checked'
import { Button, FormSection, Note, TextField } from '../../../../../ui'
import { ConfirmChange, useChanged } from './shared'

/**
 * What the owner calls their world, says about it, and picks for its picture, plus the address
 * friends type. None of it restarts anything; the icon reaches Minecraft's server list at the
 * next start.
 */
export function Identity({ view }: { view: ServerView }) {
  // Above the fields, which start over once a change lands: "Saved" outlives that.
  const words = useOutcome(view)
  const address = useOutcome(view)
  return (
    <FormSection title="Name and address" description="What you call it, and where your friends find it.">
      <Words key={`${view.name}-${view.icon}`} view={view} outcome={words} />
      <AddressField key={view.slug} view={view} outcome={address} />
    </FormSection>
  )
}

function Words({ view, outcome }: { view: ServerView; outcome: Outcome }) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const [name, setName] = useState(view.name)
  const checkedName = useChecked(rules.serverName, name)
  const [description, setDescription] = useState(view.description)
  const [icon, setIcon] = useState<ServerIcon | null>(view.icon)
  const save = useMutation(
    trpc.servers.saveIdentity.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        outcome.settled(next)
      },
    }),
  )
  const dirty = name.trim() !== view.name || description.trim() !== view.description || icon !== view.icon

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (!dirty || name.trim().length === 0) return
    save.mutate({ serverId: view.id, name: name.trim(), description: description.trim(), icon })
  }
  return (
    <form className="bk-stack" style={{ gap: 'var(--space-16)' }} onSubmit={submit}>
      <TextField
        label="Server name"
        value={name}
        maxLength={40}
        required
        onChange={(event) => setName(event.target.value)}
        error={(save.isError ? messageOf(save.error) : null) ?? checkedName.error}
        {...checkedName.field}
      />
      <label className="bk-field">
        <span className="bk-field__label">About it</span>
        <textarea
          className="bk-input"
          rows={3}
          maxLength={1000}
          placeholder="A quiet survival world for six friends. Nothing is off limits."
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <span className="bk-field__help">Shown to anyone you share it with.</span>
      </label>
      <fieldset className="bk-stack" style={{ gap: 'var(--space-8)', border: 0, padding: 0 }}>
        <legend className="bk-field__label">Icon</legend>
        <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
          {/* Blockly's own comes first: it is what a server shows until another is picked. */}
          {[null, ...SERVER_ICONS].map((key) => (
            <button
              key={key ?? 'blockly'}
              type="button"
              className="bk-icon-pick"
              aria-pressed={icon === key}
              aria-label={key ?? 'Cubepals’ own'}
              onClick={() => setIcon(key)}
            >
              <Image src={iconSrc(key)} alt="" width={32} height={32} />
            </button>
          ))}
        </div>
        <span className="bk-field__help">
          Shown on the server’s page, and in Minecraft’s server list after the next start.
        </span>
      </fieldset>
      {/* It stays a moment after saving, to say it did. */}
      {(dirty || outcome.said !== null) && (
        <div>
          <Button type="submit" variant="secondary" size="sm" {...said(outcome)} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </form>
  )
}

function AddressField({ view, outcome }: { view: ServerView; outcome: Outcome }) {
  const trpc = useTRPC()
  const changed = useChanged(view.id)
  const [slug, setSlug] = useState(view.slug)
  const checkedSlug = useChecked(rules.address, slug)
  const [confirming, setConfirming] = useState(false)
  const wanted = slug.trim().toLowerCase()
  const dirty = wanted !== view.slug && wanted.length > 0
  const settled = useDebounced(wanted, 300)
  const preview = useQuery({
    ...trpc.servers.suggestAddress.queryOptions({ name: '', slug: settled, serverId: view.id }),
    enabled: settled.length >= 3 && settled !== view.slug,
    placeholderData: (previous) => previous,
  })
  const move = useMutation(
    trpc.servers.changeAddress.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        setConfirming(false)
        outcome.settled(next)
      },
    }),
  )
  const current = preview.data?.slug === wanted ? preview.data : null
  const taken = current !== null && !current.available

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (dirty && !taken) setConfirming(true)
  }
  return (
    <form className="bk-stack" style={{ gap: 'var(--space-12)' }} onSubmit={submit}>
      <TextField
        label="Address"
        mono
        value={slug}
        maxLength={40}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setSlug(event.target.value)}
        error={
          checkedSlug.error ?? (taken ? 'That address is taken or not allowed. Try adding a word.' : null)
        }
        {...checkedSlug.field}
        help={
          dirty && current?.available ? (
            <>
              Friends would join at{' '}
              <span className="type-mono-md" style={{ color: 'var(--ink)' }}>
                {current.joinAddress}
              </span>
            </>
          ) : (
            <>
              Friends join at{' '}
              <span className="type-mono-md" style={{ color: 'var(--ink)' }}>
                {view.joinAddress}
              </span>
            </>
          )
        }
        trailing={
          dirty || outcome.said !== null ? (
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              {...said(outcome, { done: 'Changed', failed: 'Didn’t change' })}
              disabled={taken || move.isPending}
            >
              Change
            </Button>
          ) : undefined
        }
      />
      <ConfirmChange
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Change the address?"
        confirmLabel="Change address"
        working="Changing the address"
        error={move.error}
        onConfirm={() => move.mutateAsync({ serverId: view.id, slug: wanted })}
      >
        <p>
          Your friends join at{' '}
          <span className="type-mono-md" style={{ color: 'var(--ink)' }}>
            {current?.joinAddress ?? wanted}
          </span>{' '}
          from now on. The old address stops working right away, and nobody else can take it for 30 days, in
          case you want it back. Invite links you already sent keep working.
        </p>
      </ConfirmChange>
      {move.isError && !confirming && <Note tone="danger">{messageOf(move.error)}</Note>}
    </form>
  )
}
