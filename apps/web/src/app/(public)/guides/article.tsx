/**
 * What every guide page is made of: its metadata, its frame (where it sits, its date, the one
 * button at the end, its markup), and the pieces its words use: a picture from the app, a link to
 * another guide, and its questions. The words themselves are each guide's own `page.tsx`.
 */
import type { PublicPlan } from '@blockly/contracts'
import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { publicPlans } from '../../../lib/plans'
import { currentSession } from '../../../lib/session'
import { canonicalOrigin, pageMetadata, UNLISTED } from '../../../lib/site'
import { guideSchema, JsonLd } from '../../../lib/structured-data'
import { Button } from '../../../ui'
import { GUIDES, guideHref, guidesIndexLive, liveGuide } from '../guides'
import styles from './article.module.css'

/** A guide's title, description and address; noindex until it is approved. */
export function guideMetadata(slug: string): Metadata {
  const guide = liveGuide(slug)
  const own = pageMetadata({ title: guide.title, description: guide.description, path: guideHref(guide) })
  return guide.approved ? own : { ...own, robots: UNLISTED }
}

/** The plans a guide's numbers come from, the same table the pricing page reads. */
export async function guidePlans(): Promise<{ free?: PublicPlan; paid?: PublicPlan }> {
  // Kept five minutes, as the landing page keeps it: the table seldom changes.
  const plans = await publicPlans(300)
  return {
    free: plans.find((plan) => plan.monthlyPriceCents === 0),
    paid: plans.find((plan) => plan.monthlyPriceCents > 0),
  }
}

/** A date as people read it: "7 October 2026". */
const said = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

/** The frame of a guide: where it sits, its title and date, its words, then the one button. */
export async function GuideArticle({ slug, children }: { slug: string; children: ReactNode }) {
  const guide = liveGuide(slug)
  const signedIn = (await currentSession()) !== null
  return (
    <article className={styles.article}>
      <header className={styles.header}>
        {guidesIndexLive() && (
          <p className={`type-body-sm ${styles.crumbs}`}>
            <Link href="/guides">Guides</Link>
          </p>
        )}
        <h1 className="type-display-md">{guide.title}</h1>
        <p className={`type-body-sm ${styles.meta}`}>
          Updated {said(guide.modified)} · For Minecraft: Java Edition
        </p>
      </header>
      {!guide.approved && (
        <p className={`type-body-sm ${styles.draft}`} role="note">
          <strong>Draft awaiting review.</strong> This guide isn’t published yet: search engines are asked to
          leave it out, and production doesn’t show it.
        </p>
      )}
      {children}
      <section className={styles.end} aria-labelledby="start">
        <h2 id="start" className="type-heading-md">
          Start a world with your friends
        </h2>
        <p className="type-body">
          <Link href="/">A Minecraft server that starts when your friends join</Link>. Free to start, no card
          needed.
        </p>
        <Button variant="primary" size="lg" href={signedIn ? '/servers/new' : '/sign-up'}>
          Create a server
        </Button>
      </section>
      <JsonLd
        schema={guideSchema(
          {
            title: guide.title,
            description: guide.description,
            published: guide.published,
            modified: guide.modified,
            path: guideHref(guide),
          },
          canonicalOrigin(),
        )}
      />
    </article>
  )
}

/** One part of a guide, under its own H2. */
export function Part({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className={`type-body ${styles.section}`} aria-labelledby={id}>
      <h2 id={id} className="type-heading-md">
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * A link to another guide, with words that say what it is. While that guide is unapproved in
 * production the words stay and the link doesn't, so no page points at a 404.
 */
export function GuideLink({ to, children }: { to: string; children: ReactNode }) {
  const guide = GUIDES.find((candidate) => candidate.slug === to)
  if (guide === undefined) throw new Error(`no guide called ${to}`)
  return guide.approved || guidesIndexLive() ? <Link href={guideHref(guide)}>{children}</Link> : children
}

/** A picture taken in the app, cropped to what the step shows. Its alt text says what is in it. */
export function Shot({
  src,
  width,
  height,
  alt,
  caption,
}: {
  src: string
  width: number
  height: number
  alt: string
  caption?: string
}) {
  return (
    <figure className={styles.shot}>
      <Image src={src} width={width} height={height} alt={alt} sizes="(min-width: 760px) 680px, 100vw" />
      {caption && <figcaption className="type-body-sm">{caption}</figcaption>}
    </figure>
  )
}

/** The questions people ask next, each answered in a line or two. */
export function Questions({ items }: { items: readonly { question: string; answer: ReactNode }[] }) {
  return (
    <Part id="questions" title="Questions">
      <div className={styles.questions}>
        {items.map((item) => (
          <div key={item.question} className={styles.section}>
            <h3 className="type-heading-sm">{item.question}</h3>
            <p>{item.answer}</p>
          </div>
        ))}
      </div>
    </Part>
  )
}

/** A small table of facts, read as cards on a phone. */
export function FactTable({
  head,
  rows,
}: {
  head: readonly string[]
  rows: readonly (readonly ReactNode[])[]
}) {
  return (
    <div className={`type-body-sm ${styles.table}`}>
      <table>
        <thead>
          <tr>
            {head.map((cell) => (
              <th key={cell}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={String(r)}>
              {row.map((cell, c) => (
                <td key={head[c]}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
