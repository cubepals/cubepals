// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * IndexNow (https://www.indexnow.org/documentation): after production's website deploys, every
 * page in its sitemap goes to Bing, Yandex, Seznam and Naver at once, rather than waiting for a
 * crawl. Google doesn't take part.
 *
 * The key proves the pings are the site's own. It isn't a secret: it is the one file in
 * apps/web/public named `<key>.txt` whose body is the key, served at the site's root. The URLs are
 * the sitemap as the last build prerendered it (apps/web/src/app/sitemap.ts), with production's
 * origin. Only production pings, and a ping that fails is one line, never a failed deploy.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkerSite } from './web-worker.ts'

const WEB = join(import.meta.dir, '../../apps/web')

/** IndexNow's shared endpoint, which passes each ping on to every engine that takes part. */
const ENDPOINT = 'https://api.indexnow.org/indexnow'

/** The key: the name of the public file whose body is that name. */
export function indexNowKey(publicDir = join(WEB, 'public')): string {
  const keys = readdirSync(publicDir).flatMap((file) => {
    const key = /^([0-9a-f]{8,128})\.txt$/.exec(file)?.[1]
    return key !== undefined && readFileSync(join(publicDir, file), 'utf8').trim() === key ? [key] : []
  })
  if (keys.length !== 1) throw new Error(`apps/web/public holds ${keys.length} IndexNow key files, not one`)
  return keys[0] as string
}

/** Every page the last build's sitemap.xml lists. */
export function sitemapUrls(nextDir = join(WEB, '.next')): string[] {
  const sitemap = readFileSync(join(nextDir, 'server/app/sitemap.xml.body'), 'utf8')
  return [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] as string)
}

/** Production's website alone: indexable, and wrangler.jsonc's top level, not staging's. */
export const pingsIndexNow = (site: WorkerSite): boolean => site.indexable && site.env === undefined

/** The POST IndexNow's documentation gives for a list of URLs on one host. */
export function indexNowRequest(
  origin: string,
  key: string,
  urls: string[],
): { url: string; init: RequestInit } {
  return {
    url: ENDPOINT,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: new URL(origin).host,
        key,
        keyLocation: `${origin}/${key}.txt`,
        urlList: urls,
      }),
    },
  }
}

/** The last build's sitemap sent to IndexNow, when the site is production's. Never throws. */
export async function pingIndexNow(site: WorkerSite, say: (line: string) => void): Promise<void> {
  if (!pingsIndexNow(site)) return
  try {
    const urls = sitemapUrls()
    const { url, init } = indexNowRequest(site.canonicalOrigin, indexNowKey(), urls)
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
    say(
      response.ok
        ? `IndexNow has the sitemap's ${urls.length} pages.`
        : `IndexNow turned the sitemap away (${response.status}); search engines find it as they crawl.`,
    )
  } catch (error) {
    say(
      `IndexNow wasn't reached (${(error as Error).message}); search engines find the sitemap as they crawl.`,
    )
  }
}
