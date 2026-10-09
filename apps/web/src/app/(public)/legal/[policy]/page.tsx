/**
 * One policy: its title and date, what it says in short, then the whole of it, section by
 * section, with its contents alongside on a wide screen. While the policies are drafts, the
 * page says so first.
 */
import { TERMS_VERSION } from '@blockly/contracts'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import styles from '../../../../legal/legal.module.css'
import { DRAFT } from '../../../../legal/operator'
import { hrefOf, POLICIES, policyAt } from '../../../../legal/policies'
import { Blocks, plain, Sentence } from '../../../../legal/prose'
import { pageMetadata } from '../../../../lib/site'

type Params = { params: Promise<{ policy: string }> }

export const dynamicParams = false
export const generateStaticParams = () => POLICIES.map((policy) => ({ policy: policy.slug }))

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const policy = policyAt((await params).policy)
  return policy
    ? pageMetadata({ title: policy.title, description: plain(policy.description), path: hrefOf(policy) })
    : {}
}

/** The date the policies last changed, as people read it: "3 October 2026". */
const dated = new Date(`${TERMS_VERSION}T00:00:00Z`).toLocaleDateString('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

export default async function PolicyPage({ params }: Params) {
  const policy = policyAt((await params).policy)
  if (policy === undefined) notFound()
  return (
    <div className={styles.layout}>
      <article className={styles.document}>
        <header className={styles.header}>
          <h1 className="type-display-md">{policy.title}</h1>
          <p className={`type-body-sm ${styles.meta}`}>Last updated {dated}</p>
        </header>
        {DRAFT && (
          <p className={`type-body-sm ${styles.draft}`} role="note">
            <strong>Draft awaiting review.</strong> This policy hasn’t been checked by a lawyer yet and isn’t
            in force. Details in brackets are still to be filled in.
          </p>
        )}
        <section className={styles.summary} aria-labelledby="in-short">
          <h2 id="in-short" className="type-heading-sm">
            In short
          </h2>
          <ul className="type-body">
            {policy.summary.map((line) => (
              <li key={line}>
                <Sentence text={line} />
              </li>
            ))}
          </ul>
        </section>
        {policy.sections.map((section) => (
          <section key={section.id} id={section.id} className={`type-body ${styles.section}`}>
            <h2 className="type-heading-md">
              <Sentence text={section.heading} />
            </h2>
            <Blocks blocks={section.blocks} />
          </section>
        ))}
      </article>
      <nav className={styles.contents} aria-label="Contents">
        <p className="type-heading-xs">Contents</p>
        <ol className="type-body-sm">
          {policy.sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{plain(section.heading)}</a>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  )
}
