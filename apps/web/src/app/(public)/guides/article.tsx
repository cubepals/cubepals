// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

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
import { bedrockLive } from '../../../lib/bedrock'
import { pricedPlans } from '../../../lib/plans'
import { currentSession } from '../../../lib/session'
import { canonicalOrigin, pageMetadata, UNLISTED } from '../../../lib/site'
import { guideSchema, JsonLd } from '../../../lib/structured-data'
import { Button } from '../../../ui'
import { GUIDES, guideHref, guidesIndexLive, listed, liveGuide } from '../guides'
import { GuideEnd } from '../presses'
import { ctaMark } from '../steps'
import styles from './article.module.css'

/** A guide's title, description and address; noindex until it is listed. */
export function guideMetadata(slug: string): Metadata {
  const guide = liveGuide(slug)
  const own = pageMetadata({ title: guide.title, description: guide.description, path: guideHref(guide) })
  return listed(guide) ? own : { ...own, robots: UNLISTED }
}

/**
 * The plans a guide's numbers come from, as the pricing page states them (`pricedPlans`): the free
 * trial, every paid plan, cheapest first, and the one with mods, plugins and bigger groups.
 */
export async function guidePlans(): Promise<{
  free?: PublicPlan
  paidPlans: PublicPlan[]
  paid?: PublicPlan
}> {
  // The table kept five minutes, as the landing page keeps it: it seldom changes.
  const plans = await pricedPlans(300)
  return {
    free: plans.find((plan) => plan.monthlyPriceCents === 0),
    paidPlans: plans.filter((plan) => plan.monthlyPriceCents > 0),
    paid: plans.find((plan) => plan.mods),
  }
}

/** Plan names in a sentence: "Core and Plus". */
const namesSaid = (plans: readonly PublicPlan[]): string => {
  const names = plans.map((plan) => plan.name)
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '')
}

/**
 * Where the paid plans differ from the trial in one figure, said in brackets: " (15 on Core and
 * Plus)". Empty where none differs.
 */
export function onPaidSaid(
  free: PublicPlan,
  paidPlans: readonly PublicPlan[],
  figure: (plan: PublicPlan) => number | null,
  said: (value: number) => string,
): string {
  const values = [...new Set(paidPlans.map(figure))].filter(
    (value): value is number => value !== null && value !== figure(free),
  )
  const parts = values.map(
    (value) => `${said(value)} on ${namesSaid(paidPlans.filter((plan) => figure(plan) === value))}`,
  )
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

const TIMES: Record<number, string> = { 2: 'two', 3: 'three', 4: 'four' }

/**
 * Which groups run on a server that counts more than an hour for each hour it runs, from the plan's
 * own sizes: "groups of more than 10 run on a large server, which counts two hours for each hour it
 * runs, and groups of more than 50 on the largest, which counts four". Null where none does.
 */
export function bigGroupsSaid(plan: PublicPlan | undefined): string | null {
  const sizes = plan?.sizes ?? []
  const parts = sizes.flatMap((size, i) => {
    const before = sizes[i - 1]
    if (size.hoursAnHour <= 1 || before === undefined) return []
    const times = TIMES[size.hoursAnHour] ?? String(size.hoursAnHour)
    const last = i === sizes.length - 1
    return [{ over: before.maxPlayers, times, last }]
  })
  const [first, ...rest] = parts
  if (first === undefined) return null
  const more = rest.map(
    (part) =>
      `groups of more than ${part.over} on ${part.last ? 'the largest' : 'a larger one'}, which counts ${part.times}`,
  )
  return [
    `groups of more than ${first.over} run on ${first.last ? 'the largest server' : 'a large server'}, which counts ${first.times} hours for each hour it runs`,
    ...more,
  ].join(', and ')
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
        <h1 className="type-display-md">{guide.heading ?? guide.title}</h1>
        <p className={`type-body-sm ${styles.meta}`}>
          Updated {said(guide.modified)} · For Minecraft: Java Edition
          {guide.bedrock && bedrockLive() ? ' and Bedrock Edition' : ''}
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
          <Link href="/">Minecraft server hosting for friends</Link>. Send them the address and they’re in.
          Start with a free trial, no card needed.
        </p>
        <Button
          variant="primary"
          size="lg"
          href={signedIn ? '/servers/new' : '/sign-up'}
          {...ctaMark('guide_create')}
        >
          Create a server
        </Button>
        <GuideEnd slug={slug} />
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
