import type { Metadata } from 'next'
import { UNLISTED } from '../../../../lib/site'
import { playingLine, publicUrl, statusOf } from '../../status'
import { PublicServerView } from './view'

/**
 * Pasted into a chat, a server's link should say what it is without anyone opening it, so the
 * title and description are rendered on the server while the page itself stays live. Where
 * Blockly couldn't answer just then, it says nothing but its own name, rather than calling a
 * server that is busy for a minute private. Every server page stays out of search for now, public
 * ones included.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  return { ...(await previewOf(slug)), alternates: { canonical: `/server/${slug}` }, robots: UNLISTED }
}

async function previewOf(slug: string): Promise<Metadata> {
  const status = await statusOf(slug)
  if (status === 'unanswered') return {}
  if (status === 'missing') return { title: 'A private server' }
  const description = status.description || playingLine(status)
  const image = await publicUrl(`/api/public/servers/${slug}/card.png`)
  return {
    title: status.name,
    description,
    openGraph: {
      title: status.name,
      description,
      type: 'website',
      images: [{ url: image, width: 1200, height: 630, alt: status.name }],
    },
  }
}

export default function Page() {
  return <PublicServerView />
}
