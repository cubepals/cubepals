import Link from 'next/link'
import { footerGuides, guideHref, guidesIndexLive } from '../guides'

/**
 * The guides a footer links to, as links: the first how-to guides once they are approved, and,
 * where asked, the /guides index. The landing page's footer leaves the index out, since it would
 * list the comparisons, which the landing page never links.
 */
export function GuideLinks({ index = false }: { index?: boolean }) {
  return (
    <>
      {index && guidesIndexLive() && <Link href="/guides">Guides</Link>}
      {footerGuides().map((guide) => (
        <Link key={guide.slug} href={guideHref(guide)}>
          {guide.title}
        </Link>
      ))}
    </>
  )
}
