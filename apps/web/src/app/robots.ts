import type { MetadataRoute } from 'next'
import { canonicalOrigin, indexable } from '../lib/site'

/**
 * Production lets every crawler in, AI crawlers included, keeps
 * them out of the API, and names the sitemap. Every other deployment turns them all away. Private
 * pages aren't disallowed here: they carry noindex, which a crawler can only read if it may fetch them.
 */
export default function robots(): MetadataRoute.Robots {
  if (!indexable()) return { rules: { userAgent: '*', disallow: '/' } }
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/api/' },
    sitemap: `${canonicalOrigin()}/sitemap.xml`,
  }
}
