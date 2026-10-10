// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import Link from 'next/link'
import type { ReactNode } from 'react'

export function Card({
  title,
  description,
  footer,
  href,
  tone,
  flat,
  size,
  children,
  className,
}: {
  title?: ReactNode
  description?: ReactNode
  footer?: ReactNode
  /** The whole card is the link; no separate "View" button. */
  href?: string
  /** `sand` at most once per page. */
  tone?: 'surface' | 'forest' | 'sand'
  /** Border instead of shadow. Never both. */
  flat?: boolean
  size?: 'md' | 'lg'
  children?: ReactNode
  className?: string
}) {
  const classes = [
    'bk-card',
    tone && tone !== 'surface' && `bk-card--${tone}`,
    flat && 'bk-card--flat',
    size === 'lg' && 'bk-card--lg',
    href && 'bk-card--link',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  const content = (
    <>
      {title && <h3 className="bk-card__title">{title}</h3>}
      {description && <p className="bk-card__desc">{description}</p>}
      {children}
      {footer && <div className="bk-card__foot">{footer}</div>}
    </>
  )
  return href ? (
    <Link href={href} className={classes}>
      {content}
    </Link>
  ) : (
    <div className={classes}>{content}</div>
  )
}

export function EmptyState({
  art,
  title,
  description,
  action,
  danger,
}: {
  art?: ReactNode
  title: string
  description?: ReactNode
  /** One action. Empty states invite; they do not report. */
  action?: ReactNode
  danger?: boolean
}) {
  return (
    <div className={['bk-empty', danger && 'bk-empty--danger'].filter(Boolean).join(' ')}>
      {art && <div className="bk-empty__art">{art}</div>}
      <h2 className="bk-empty__title">{title}</h2>
      {description && <p className="bk-empty__copy">{description}</p>}
      {action}
    </div>
  )
}

export function Badge({
  tone = 'neutral',
  mono,
  children,
}: {
  tone?: 'neutral' | 'grass' | 'info' | 'danger' | 'outline' | 'inverse'
  mono?: boolean
  children: ReactNode
}) {
  return (
    <span
      className={['bk-badge', tone !== 'neutral' && `bk-badge--${tone}`, mono && 'bk-badge--mono']
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  )
}

/**
 * A page that couldn't load. Every failure leads somewhere: the sentence the API wrote, and the
 * one action that might fix it, which for a read is asking again.
 */
export function LoadFailed({ error, onRetry }: { error: ReactNode; onRetry: () => void }) {
  return (
    <Note tone="danger">
      <span className="bk-row bk-wrap" style={{ gap: 'var(--space-12)', alignItems: 'center' }}>
        <span>{error}</span>
        <button type="button" className="bk-btn bk-btn--ghost bk-btn--sm" onClick={onRetry}>
          Try again
        </button>
      </span>
    </Note>
  )
}

export function Note({ tone, children }: { tone: 'info' | 'danger' | 'success'; children: ReactNode }) {
  return (
    <div className={`bk-note bk-note--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}

export function DangerZone({
  items,
}: {
  items: Array<{ label: string; description: string; action: ReactNode }>
}) {
  return (
    <section className="bk-danger" aria-label="Danger zone">
      <h2 className="bk-danger__title">Danger zone</h2>
      {items.map((item) => (
        <div key={item.label} className="bk-danger__row">
          <div>
            <div className="bk-danger__label">{item.label}</div>
            <p className="bk-danger__desc">{item.description}</p>
          </div>
          {item.action}
        </div>
      ))}
    </section>
  )
}

export function Skeleton({ width, height = 12 }: { width: string | number; height?: number }) {
  return <div className="bk-skeleton" style={{ width, height }} aria-hidden />
}

/**
 * A page still on its way, drawn as the page it becomes: its own heading, which needs no data,
 * then one block shaped like a FormSection for each section it opens with, with as many rows as
 * that section has. Seen only on a first visit to a page whose data wasn't asked for ahead.
 */
export function PageSkeleton({
  title,
  lead,
  sections,
}: {
  /** The page's heading, shown as it will be. */
  title?: string
  /** A line under the heading that waits on data, like the account's email. */
  lead?: ReactNode
  /** Each section's rows, in order: `[0, 3]` is a section of heading only, then one of three rows. */
  sections: readonly number[]
}) {
  return (
    <div className="bk-stack" style={{ gap: 'var(--space-40)' }} aria-busy>
      {title !== undefined && (
        <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
          <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
            {title}
          </h1>
          {lead}
        </header>
      )}
      {sections.map((rows, section) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders in a fixed order, never moved.
        <div key={section} className="bk-formsection" aria-hidden>
          <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
            <Skeleton width="40%" height={20} />
            <Skeleton width="75%" height={14} />
          </div>
          {Array.from({ length: rows }, (_, row) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: as above.
              key={row}
              className="bk-row"
              style={{ justifyContent: 'space-between', gap: 'var(--space-24)' }}
            >
              <Skeleton width="45%" height={16} />
              <Skeleton width={96} height={16} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
