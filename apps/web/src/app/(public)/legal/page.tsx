import type { Metadata } from 'next'
import Link from 'next/link'
import styles from '../../../legal/legal.module.css'
import { OPERATOR } from '../../../legal/operator'
import { hrefOf, POLICIES } from '../../../legal/policies'
import { Sentence } from '../../../legal/prose'
import { pageMetadata } from '../../../lib/site'

export const metadata: Metadata = pageMetadata({
  title: 'Legal',
  description: `The policies ${OPERATOR.brand} works by, and who runs it.`,
  path: '/legal',
})

/** Every policy in one place, and who runs the service and how to reach them. */
export default function LegalIndex() {
  return (
    <>
      <header className="bk-stack" style={{ gap: 'var(--space-8)' }}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          Legal
        </h1>
        <p className="type-body" style={{ color: 'var(--ink-muted)', maxWidth: 'var(--width-prose)' }}>
          <Sentence text="{brand} is run by {name}, a sole trader based in {country}. Questions about anything here go to {support}; legal notices to {legal}; your personal data to {privacy}." />
        </p>
      </header>
      <ul className={styles.index}>
        {POLICIES.map((policy) => (
          <li key={policy.slug}>
            <Link href={hrefOf(policy)}>
              <span className="type-heading-sm">{policy.title}</span>
              <span className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
                <Sentence text={policy.description} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}
