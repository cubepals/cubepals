// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { isBedrockUuid, shownName } from '@blockly/contracts'
import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { PlayerFace } from './face'
import { type PillStatus, StatusPill } from './status'
import { Badge } from './surfaces'

/** What a server's card shows of it, whichever way the card is drawn. */
interface Shown {
  name: string
  status: PillStatus
  statusLabel?: string
  /** Its Minecraft version, where there is one to show. */
  version?: string
  loader: string
  /** The modpack it plays, shown in place of its loader: the pack is what it is. */
  pack?: { name: string; icon: string | null } | null | undefined
  /** One live line: "12 / 20 players", or the wait while it is being built. */
  detail: string
  address: string
}

/** The servers page's card: pressing it opens the server's page, under its world's cover. */
interface Linked {
  href: string
  /** The world's cover, cropped to 3:2 by the card. */
  image: string
  action?: never
  live?: never
}

/**
 * A card with a button of its own, which a link can't hold. Its world is drawn beside it rather
 * than over it (the landing's island), so it has no cover: its state sits beside its name, which
 * isn't a heading on a card that stands alone, and the button sits at its foot, beside the line
 * a press of it changes.
 */
interface Own {
  href?: never
  image?: never
  action: ReactNode
  /** Whether a change of its detail is said aloud: only once the visitor has asked for one. */
  live?: boolean
}

export function ServerCard(props: Shown & (Linked | Own)) {
  if (props.href === undefined) return <OwnCard {...props} />
  const { href, image, name, status, statusLabel, detail, address } = props
  return (
    // Fetched whole as soon as the card shows, so pressing it opens the server at once.
    <Link href={href} prefetch className="bk-server">
      <div className="bk-server__media">
        <Image
          src={image}
          alt=""
          draggable={false}
          fill
          sizes="(min-width: 1280px) 360px, (min-width: 640px) 50vw, 100vw"
        />
        <span className="bk-server__status">
          <StatusPill status={status} {...(statusLabel ? { label: statusLabel } : {})} />
        </span>
      </div>
      <div className="bk-server__body">
        <h3 className="bk-server__name">{name}</h3>
        <Runs {...props} />
        <p className="bk-server__detail bk-num">{detail}</p>
        <span className="bk-server__addr">{address}</span>
      </div>
    </Link>
  )
}

function OwnCard({ name, status, statusLabel, detail, address, action, live, ...runs }: Shown & Own) {
  return (
    <div className="bk-server">
      <div className="bk-server__body">
        <div className="bk-server__head">
          <p className="bk-server__name">{name}</p>
          <StatusPill status={status} {...(statusLabel ? { label: statusLabel } : {})} />
        </div>
        <Runs {...runs} />
        <span className="bk-server__addr">{address}</span>
        <div className="bk-server__foot">
          <p className="bk-server__detail bk-num" aria-live={live ? 'polite' : undefined}>
            {detail}
          </p>
          {action}
        </div>
      </div>
    </div>
  )
}

/** What a server runs, under its name: its version, and its modpack or else its loader. */
function Runs({ version, loader, pack }: Pick<Shown, 'version' | 'loader' | 'pack'>) {
  return (
    <div className="bk-server__meta">
      {version !== undefined && <Badge mono>{version}</Badge>}
      {pack ? <PackBadge name={pack.name} icon={pack.icon} /> : <Badge>{loader}</Badge>}
    </div>
  )
}

/**
 * A modpack by its own picture and name, so a server playing one is known by it at a glance.
 * Without a picture it wears the chest Blockly shows for "A modpack" when a server is made.
 */
export function PackBadge({ name, icon }: { name: string; icon: string | null }) {
  return (
    <Badge>
      {/* biome-ignore lint/performance/noImgElement: a pre-sized third-party thumbnail, as in the pack picker */}
      <img
        className="bk-badge__icon"
        src={icon ?? '/server-icons/chest.svg'}
        alt=""
        draggable={false}
        width={16}
        height={16}
      />
      {name}
    </Badge>
  )
}

export function PlayerRow({
  name,
  uuid,
  meta,
  metaTone,
  online = true,
  badge,
  action,
  href,
}: {
  name: string
  /** Who the server knows them by, for the face on their skin. */
  uuid?: string | undefined
  meta?: ReactNode
  metaTone?: 'danger'
  online?: boolean
  badge?: ReactNode
  action?: ReactNode
  /** Their own page, which pressing the face or the name opens. */
  href?: string | undefined
}) {
  const who = (
    <>
      <PlayerFace name={name} uuid={uuid} />
      <div className="bk-player__body">
        <div className="bk-row" style={{ gap: 'var(--space-8)', flexWrap: 'wrap' }}>
          <span className="bk-player__name">{uuid === undefined ? name : shownName({ uuid, name })}</span>
          {uuid !== undefined && isBedrockUuid(uuid) && <Badge tone="outline">Bedrock</Badge>}
          {badge}
        </div>
        {meta && (
          <div
            className={['bk-player__meta', metaTone === 'danger' && 'bk-player__meta--danger']
              .filter(Boolean)
              .join(' ')}
          >
            {meta}
          </div>
        )}
      </div>
    </>
  )
  return (
    <div className={['bk-player', !online && 'bk-player--offline'].filter(Boolean).join(' ')}>
      {href === undefined ? (
        who
      ) : (
        <Link href={href} className="bk-player__link">
          {who}
        </Link>
      )}
      {action}
    </div>
  )
}
