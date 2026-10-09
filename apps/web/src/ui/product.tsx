import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { PlayerFace } from './face'
import { type PillStatus, StatusPill } from './status'
import { Badge } from './surfaces'

export function ServerCard({
  href,
  name,
  status,
  statusLabel,
  image,
  version,
  loader,
  pack,
  detail,
  address,
}: {
  href: string
  name: string
  status: PillStatus
  statusLabel?: string
  /** The world's cover, cropped to 3:2 by the card. */
  image: string
  version: string
  loader: string
  /** The modpack it plays, shown in place of its loader: the pack is what it is. */
  pack?: { name: string; icon: string | null } | null | undefined
  /** One live line: "12 / 20 players", or the wait while it is being built. */
  detail: string
  address: string
}) {
  return (
    <Link href={href} className="bk-server">
      <div className="bk-server__media">
        <Image src={image} alt="" fill sizes="(min-width: 1280px) 360px, (min-width: 640px) 50vw, 100vw" />
        <span className="bk-server__status">
          <StatusPill status={status} {...(statusLabel ? { label: statusLabel } : {})} />
        </span>
      </div>
      <div className="bk-server__body">
        <h3 className="bk-server__name">{name}</h3>
        <div className="bk-server__meta">
          <Badge mono>{version}</Badge>
          {pack ? <PackBadge name={pack.name} icon={pack.icon} /> : <Badge>{loader}</Badge>}
        </div>
        <p className="bk-server__detail bk-num">{detail}</p>
        <span className="bk-server__addr">{address}</span>
      </div>
    </Link>
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
      <img className="bk-badge__icon" src={icon ?? '/server-icons/chest.svg'} alt="" width={16} height={16} />
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
        <div className="bk-row" style={{ gap: 'var(--space-8)' }}>
          <span className="bk-player__name">{name}</span>
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
