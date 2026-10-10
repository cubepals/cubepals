// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The /guides index: every approved guide. Off production it also lists the drafts waiting for
 * review, marked as drafts, so they can be read in a preview; production never shows a
 * draft, and has no index at all until the first guide is approved.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { pageMetadata } from '../../../lib/site'
import { draftGuides, type Guide, guideHref, guidesIndexLive, publishedGuides } from '../guides'
import styles from './article.module.css'

export const metadata: Metadata = pageMetadata({
  title: 'Guides to playing Minecraft with friends',
  description:
    'How to set up a Minecraft server for your friends, what it costs, and how they join. For Minecraft: Java Edition.',
  path: '/guides',
})

export default function GuidesIndex() {
  if (!guidesIndexLive()) notFound()
  const drafts = draftGuides()
  return (
    <>
      <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          Guides to playing Minecraft with friends
        </h1>
        <p className="type-body" style={{ color: 'var(--ink-muted)', maxWidth: 'var(--width-prose)' }}>
          How to set up a server for your friends, what it costs, and how they join. Every guide is for
          Minecraft: Java Edition.
        </p>
      </header>
      <GuideList guides={publishedGuides()} />
      {drafts.length > 0 && (
        <section className="bk-stack" style={{ gap: 'var(--space-12)' }} aria-labelledby="drafts">
          <h2 id="drafts" className="type-heading-md" style={{ color: 'var(--ink)' }}>
            Drafts awaiting review
          </h2>
          <p className="type-body-sm" style={{ color: 'var(--ink-muted)', maxWidth: 'var(--width-prose)' }}>
            Shown here because this isn’t production. They go up once each one is approved.
          </p>
          <GuideList guides={drafts} />
        </section>
      )}
    </>
  )
}

function GuideList({ guides }: { guides: readonly Guide[] }) {
  return (
    <ul className={styles.index}>
      {guides.map((guide) => (
        <li key={guide.slug}>
          <Link href={guideHref(guide)}>
            <span className="type-heading-sm">{guide.title}</span>
            <span className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
              {guide.description}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
