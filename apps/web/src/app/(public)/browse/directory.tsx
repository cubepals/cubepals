'use client'

/**
 * The directory itself: the search, the filters and a card for each server, read in the browser
 * because it changes as people type. Its page, title and robots are `page.tsx`.
 */
import { type ListingCardView, SERVER_TAGS } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import Image from 'next/image'
import Link from 'next/link'
import { useState } from 'react'
import { messageOf, useTRPC } from '../../../lib/api'
import { useDebounced } from '../../../lib/hooks'
import { iconSrc, loaderLabel, timeAgo } from '../../../lib/present'
import { useSignedIn } from '../../../lib/viewer'
import { Badge, EmptyState, Note, Skeleton, TextField } from '../../../ui'
import { Reactions } from '../reactions'
import styles from './browse.module.css'

type Kind = 'any' | 'vanilla' | 'modded'

/** The public directory: servers people run on Blockly and chose to share. */
export function Directory() {
  const trpc = useTRPC()
  const signedIn = useSignedIn()
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState<(typeof SERVER_TAGS)[number] | null>(null)
  const [onlineNow, setOnlineNow] = useState(false)
  const [kind, setKind] = useState<Kind>('any')
  const settled = useDebounced(search.trim(), 300)
  const found = useQuery({
    ...trpc.listings.browse.queryOptions({ search: settled, tag, onlineNow, kind }),
    placeholderData: (previous) => previous,
  })
  return (
    <>
      <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          Find a server
        </h1>
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          Servers people run on Cubepals and chose to share. Open one to see how to join; a sleeping server
          wakes up when you do.
        </p>
      </header>
      <TextField
        label="Search"
        placeholder="Castles, skyblock, a friendly survival world…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        autoComplete="off"
      />
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
        <button
          type="button"
          className="bk-tag"
          aria-pressed={onlineNow}
          onClick={() => setOnlineNow(!onlineNow)}
        >
          someone playing
        </button>
        {(['vanilla', 'modded'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="bk-tag"
            aria-pressed={kind === value}
            onClick={() => setKind(kind === value ? 'any' : value)}
          >
            {value}
          </button>
        ))}
      </div>
      <fieldset className="bk-chips" style={{ gap: 'var(--space-8)' }}>
        <legend className="bk-visually-hidden">Tags</legend>
        {SERVER_TAGS.map((name) => (
          <button
            key={name}
            type="button"
            className="bk-tag"
            aria-pressed={tag === name}
            onClick={() => setTag(tag === name ? null : name)}
          >
            {name}
          </button>
        ))}
      </fieldset>
      {found.isError && <Note tone="danger">{messageOf(found.error)}</Note>}
      {found.isPending ? (
        <Skeleton width="100%" height={160} />
      ) : found.data?.paused ? (
        <EmptyState
          title="The directory is paused"
          description="Servers are still running; the list is back soon."
        />
      ) : found.data?.listings.length === 0 &&
        (settled !== '' || tag !== null || onlineNow || kind !== 'any') ? (
        <EmptyState title="Nothing matches" description="Try other words, or fewer filters." />
      ) : found.data?.listings.length === 0 ? (
        // Nobody has shared a server yet: an owner looking at an empty list is told how theirs gets in.
        <EmptyState
          title="No servers here yet"
          description={
            signedIn
              ? 'A server shows up here when its owner lets anyone find it: on your server, open Share and turn on “Anyone can find it”.'
              : 'A server shows up here when its owner lets anyone find it.'
          }
        />
      ) : (
        <div className="bk-grid bk-grid--three">
          {found.data?.listings.map((listing) => (
            <Card key={listing.serverId} listing={listing} />
          ))}
        </div>
      )}
    </>
  )
}

/**
 * A server in the directory. The whole card opens its page, yet it holds buttons of its own,
 * which a link can't: so the name is the link, stretched over the card beneath the reactions.
 */
function Card({ listing }: { listing: ListingCardView }) {
  const now = Date.now()
  return (
    <article className={`bk-card bk-card--link bk-stack ${styles.card}`}>
      <header className="bk-row" style={{ gap: 'var(--space-12)', alignItems: 'flex-start' }}>
        <Image
          src={iconSrc(listing.icon)}
          alt=""
          width={40}
          height={40}
          style={{ imageRendering: 'pixelated' }}
        />
        <div className="bk-stack" style={{ gap: 'var(--space-4)', minWidth: 0 }}>
          <h2 className="type-title-md">
            <Link href={`/server/${listing.slug}`} className={styles.open}>
              {listing.name}
            </Link>
          </h2>
          <span className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            {listing.awake
              ? `${listing.online} playing`
              : listing.lastPlayedAt
                ? `Asleep · played ${timeAgo(listing.lastPlayedAt, now)}`
                : 'Asleep'}
            {listing.gameVersion && ` · ${listing.gameVersion}`}
            {listing.loader && listing.loader !== 'vanilla' && ` ${loaderLabel(listing.loader)}`}
          </span>
        </div>
      </header>
      {listing.description && (
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          {listing.description.length > 140 ? `${listing.description.slice(0, 140)}…` : listing.description}
        </p>
      )}
      {/* At the foot of every card, so the counts line up along a row of them. */}
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)', marginBlockStart: 'auto' }}>
        {listing.whitelistOnly && <Badge tone="outline">Invite only</Badge>}
        {listing.tags.slice(0, 3).map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
        <Reactions reactions={listing.reactions} />
      </div>
    </article>
  )
}
