/**
 * OpenNext's Cloudflare build for the web app. Nothing here revalidates on demand (no
 * revalidateTag or revalidatePath), so there is no tag cache and no queue. The landing page and
 * the guides keep the control plane's plans for five minutes (next.revalidate in lib/plans.ts):
 * that data cache lives in R2, read through each colo's Cache API so most reads never reach it.
 */
import { defineCloudflareConfig } from '@opennextjs/cloudflare'
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache'
import { withRegionalCache } from '@opennextjs/cloudflare/overrides/incremental-cache/regional-cache'

export default defineCloudflareConfig({
  incrementalCache: withRegionalCache(r2IncrementalCache, { mode: 'long-lived' }),
  enableCacheInterception: true,
})
