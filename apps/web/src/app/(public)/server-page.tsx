// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import type { PublicServerView } from '@blockly/contracts'
import { useMutation } from '@tanstack/react-query'
import { CopyPlus, ExternalLink } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { type SubmitEvent, useState } from 'react'
import { messageOf, useTRPC } from '../../lib/api'
import { iconSrc, joinLine, loaderLabel } from '../../lib/present'
import * as rules from '../../lib/rules'
import { useChecked } from '../../lib/use-checked'
import { behindSignUp, useSignedIn } from '../../lib/viewer'
import { Badge, Button, CopyField, FormSection, GetPack, Note, TextField } from '../../ui'
import styles from './like-this.module.css'
import { Reactions } from './reactions'
import { ReportServer, reportable } from './report'

/**
 * A server as the people it is shared with see it: its own page, and the same page reached
 * through an invitation. It is written for a player, not an owner — what it is, whether anyone
 * is on, what to install, and the address — and says nothing about machines.
 */
export function ServerPage({ view, invitedBy }: { view: PublicServerView; invitedBy?: string }) {
  return (
    <>
      {view.preview && (
        <Note tone="info">
          Only you can see this page. Turn on “Anyone can find it” in Share to open it to everyone.
        </Note>
      )}
      <header className="bk-row bk-wrap" style={{ gap: 'var(--space-16)', alignItems: 'center' }}>
        {/* Square, as Minecraft's server list shows it. */}
        <Image
          src={iconSrc(view.icon)}
          alt=""
          width={64}
          height={64}
          style={{ imageRendering: 'pixelated' }}
        />
        <div className="bk-stack" style={{ gap: 'var(--space-4)' }}>
          {view.invited && (
            <span className="type-label" style={{ color: 'var(--ink-muted)' }}>
              {invitedBy ? `${invitedBy} invited you to` : 'You’re invited to'}
            </span>
          )}
          <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
            {view.name}
          </h1>
          <span
            className="type-body bk-row bk-wrap"
            style={{ gap: 'var(--space-8)', color: 'var(--ink-muted)' }}
          >
            {view.awake
              ? `${view.online} of ${view.maxPlayers} playing`
              : view.wakesSlowly
                ? 'Asleep — it wakes up when you join. This one takes a couple of minutes.'
                : 'Asleep — it wakes up when you join'}
            {view.whitelistOnly && <Badge tone="outline">Invite only</Badge>}
          </span>
        </div>
        {/* Its public page only: an invitation and the owner's preview have none. */}
        {view.reactions && <Reactions reactions={view.reactions} />}
      </header>

      {view.description && (
        <p className="type-body" style={{ color: 'var(--ink-muted)', whiteSpace: 'pre-wrap' }}>
          {view.description}
        </p>
      )}

      <FormSection title="Join" description={joinLine(view.gameVersion, view.needs.modpack)}>
        <CopyField value={view.joinAddress} />
        {view.players.length > 0 && (
          <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            On now: {view.players.join(', ')}.
          </p>
        )}
      </FormSection>

      <Needs view={view} />

      {view.tags.length > 0 && (
        <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
          {view.tags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
      )}
    </>
  )
}

/** What a player installs first, if anything. Most servers need nothing at all. */
function Needs({ view }: { view: PublicServerView }) {
  const { loader, mods, modpack } = view.needs
  if (modpack !== null)
    return (
      <FormSection
        title="What you need first"
        description={`This server plays ${modpack.name}. Install this exact version and you have everything: the mods, the settings, all of it.`}
      >
        <GetPack pack={modpack} gameVersion={view.gameVersion} />
      </FormSection>
    )
  if (loader === null && mods.length === 0)
    return (
      <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        Nothing to install: plain Minecraft {view.gameVersion} joins this server.
        {view.loader !== 'vanilla' && ' Its mods run on the server only.'}
      </p>
    )
  return (
    <FormSection
      title="What you need first"
      description={
        loader
          ? `${loader.label}${loader.version ? ` ${loader.version}` : ''} for Minecraft ${view.gameVersion}, and these in your own game.`
          : `These in your own game, on Minecraft ${view.gameVersion}.`
      }
    >
      <ul className="bk-stack type-body" style={{ gap: 'var(--space-8)', paddingLeft: 'var(--space-20)' }}>
        {mods.map((mod) => (
          <li key={mod.name}>
            {mod.url ? (
              <a href={mod.url} target="_blank" rel="noreferrer">
                {mod.name} <ExternalLink size={12} aria-hidden />
              </a>
            ) : (
              <>{mod.name} — ask the owner for it</>
            )}
          </li>
        ))}
      </ul>
    </FormSection>
  )
}

/**
 * The other thing someone does with a server they like: make one of their own set up the same
 * way. It is an aside to joining, so it is small and set apart, and it says the world doesn't
 * come with it, since nobody should have to guess: it does not, and that is the point. `invite`
 * is the one the page was opened through, which lets its holder copy a private server.
 */
function LikeThis({ view, invite }: { view: PublicServerView; invite?: string | undefined }) {
  const signedIn = useSignedIn()
  const query = new URLSearchParams({ like: view.slug, ...(invite === undefined ? {} : { invite }) })
  return (
    <aside className={styles.likeThis}>
      <span className={styles.offer}>
        <CopyPlus size={18} strokeWidth={1.75} className={styles.icon} aria-hidden />
        <span className={`type-body-sm ${styles.line}`}>
          Want your own? The same Minecraft{view.mods.length > 0 ? ' and mods' : ''}, with a world of your
          own.
        </span>
      </span>
      <Button variant="outline" size="sm" href={behindSignUp(signedIn, `/servers/new?${query}`)}>
        Make one like this
      </Button>
    </aside>
  )
}

/**
 * An invitation's own offer: on a server only named players may join, the invitee puts their own
 * Minecraft name on the list. No account, no waiting for the owner.
 */
export function JoinThroughInvite({ code, view }: { code: string; view: PublicServerView }) {
  const trpc = useTRPC()
  const [playerName, setPlayerName] = useState('')
  const join = useMutation(trpc.sharing.join.mutationOptions())
  const checked = useChecked(rules.playerName, playerName)
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (!checked.check()) return
    join.mutate({ code, playerName: playerName.trim() })
  }
  if (!view.whitelistOnly) return null
  // Someone already on it who asks again is told so, rather than shown the form as if nothing happened.
  if (join.data)
    return (
      <Note tone="success">
        {join.data.added ? 'You’re on the list' : 'You’re on the list already'}, {join.data.playerName}. Add{' '}
        {view.joinAddress} in Minecraft and join
        {join.data.asleep ? '; the server wakes up when you do.' : '.'}
      </Note>
    )
  return (
    <FormSection
      title="Get yourself in"
      description="Only players the owner allows can join. Your Minecraft name is enough."
    >
      <form className="bk-row bk-wrap" style={{ gap: 'var(--space-12)' }} onSubmit={submit}>
        <TextField
          label="Your Minecraft name"
          value={playerName}
          maxLength={16}
          autoComplete="off"
          spellCheck={false}
          error={checked.error}
          help={view.checksAccounts ? undefined : 'Exactly as it is in the game: capitals count.'}
          onChange={(event) => setPlayerName(event.target.value)}
          {...checked.field}
        />
        <Button type="submit" variant="primary" disabled={join.isPending || playerName.trim().length < 3}>
          {join.isPending ? 'Adding you…' : 'Let me in'}
        </Button>
      </form>
      {join.isError && <Note tone="danger">{messageOf(join.error)}</Note>}
    </FormSection>
  )
}

/**
 * Whether the page offers to make one like it. Not on the owner's own page, where it would offer
 * them their own server; except while developing, so the offer can be seen and tried.
 */
const offersCopy = (view: PublicServerView): boolean =>
  view.copyable && (!view.yours || process.env.NODE_ENV === 'development')

/**
 * The foot of every shared page. Where the page offers to make one like it, that offer sits at the
 * bottom, after joining and anything an invitation adds, with the empty height above it; then the
 * line saying what runs the server, which offers a server of one's own only when the page doesn't
 * already offer this one, and at its end, on a public page, the way to report the server.
 */
export function RunsOnBlockly({ view, invite }: { view: PublicServerView; invite?: string }) {
  const signedIn = useSignedIn()
  const reporting = reportable(view, signedIn)
  return (
    <>
      {offersCopy(view) && (
        <>
          <div className={styles.push} aria-hidden />
          <LikeThis view={view} invite={invite} />
        </>
      )}
      <div
        className="bk-row bk-wrap"
        style={{ gap: 'var(--space-8)', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <p className="type-body-sm" style={{ color: 'var(--ink-subtle)' }}>
          {/* A pack players install is what they know the server by; its loader is the pack's business. */}
          {view.needs.modpack !== null
            ? `${view.needs.modpack.name} ${view.needs.modpack.version}`
            : `${view.loader === 'vanilla' ? 'Minecraft' : loaderLabel(view.loader)} ${view.gameVersion}`}{' '}
          on <Link href="/">Cubepals</Link>.
          {!offersCopy(view) && (
            <>
              {' '}
              <Link href={behindSignUp(signedIn, '/servers/new')}>Make one of your own</Link>.
            </>
          )}
        </p>
        {/* Out of everyone's way at the very end, for the few who need it. */}
        {reporting !== null && <ReportServer serverId={reporting} />}
      </div>
    </>
  )
}
