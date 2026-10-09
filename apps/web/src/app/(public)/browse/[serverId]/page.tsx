import { notFound, permanentRedirect } from 'next/navigation'
import { apiUpstream } from '../../../../lib/upstream'

/**
 * Where a listing used to live. A server's page is its own address now, so a link shared before
 * is sent there with a permanent redirect, which a crawler follows too; a listing that's gone is a 404.
 */
export default async function ListingRedirect({ params }: { params: Promise<{ serverId: string }> }) {
  const input = encodeURIComponent(JSON.stringify({ serverId: (await params).serverId }))
  const response = await fetch(`${apiUpstream()}/api/trpc/listings.get?input=${input}`, { cache: 'no-store' })
  const slug = response.ok
    ? ((await response.json()) as { result?: { data?: { slug?: string } } }).result?.data?.slug
    : null
  if (!slug) notFound()
  permanentRedirect(`/server/${slug}`)
}
