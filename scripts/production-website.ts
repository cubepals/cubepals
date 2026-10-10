/**
 * cubepals.com on Vercel, through Vercel's API: a production build of one commit, waited on until
 * it is live, and the commit the site was built from before the current one, for a rollback.
 *
 * Vercel builds the `production` branch when it moves, but on this project the builds a push
 * starts end skipped (2026-10-10), while one asked for through the API builds. So production.ts
 * pushes the branch and then asks for the build here. A rollback builds the earlier commit again
 * rather than using Vercel's own instant rollback, which stops later builds from going live until
 * it is undone. Nothing here prints the token.
 */

const API = 'https://api.vercel.com'

interface Site {
  token: string
  team: string
  project: string
  /** `owner/name` on GitHub. */
  repository: string
}

interface Deployment {
  uid: string
  state: string
  created: number
  meta?: { githubCommitSha?: string }
}

async function vercel(site: Site, path: string, init: RequestInit = {}): Promise<unknown> {
  const separator = path.includes('?') ? '&' : '?'
  const response = await fetch(`${API}${path}${separator}teamId=${site.team}`, {
    ...init,
    headers: { Authorization: `Bearer ${site.token}`, 'Content-Type': 'application/json' },
  })
  if (!response.ok) throw new Error(`Vercel answered ${response.status} to ${path.split('?')[0]}`)
  return response.json()
}

/** Builds `sha` (on the production branch) as the production site and waits until it is live. */
export async function buildWebsite(site: Site, sha: string, say: (line: string) => void): Promise<void> {
  const [org, repo] = site.repository.split('/')
  const made = (await vercel(site, '/v13/deployments', {
    method: 'POST',
    body: JSON.stringify({
      name: site.project,
      project: site.project,
      target: 'production',
      gitSource: { type: 'github', org, repo, ref: 'production', sha },
    }),
  })) as { id: string }
  say(`Vercel is building cubepals.com from ${sha.slice(0, 8)}.`)
  for (let tries = 0; tries < 60; tries++) {
    await Bun.sleep(15_000)
    const { readyState } = (await vercel(site, `/v13/deployments/${made.id}`)) as { readyState: string }
    if (readyState === 'READY') {
      say('cubepals.com is live from it.')
      return
    }
    if (readyState === 'ERROR' || readyState === 'CANCELED')
      throw new Error(`Vercel's build ended ${readyState}: see ${made.id} on Vercel.`)
  }
  throw new Error(`Vercel's build ${made.id} wasn't live after 15 minutes.`)
}

/** The commit the live site was built from, and the one before it that was live, newest first. */
export async function liveCommits(site: Site): Promise<string[]> {
  const { deployments } = (await vercel(
    site,
    `/v6/deployments?app=${site.project}&target=production&state=READY&limit=20`,
  )) as { deployments: Deployment[] }
  const commits: string[] = []
  for (const deployment of [...deployments].sort((a, b) => b.created - a.created)) {
    const sha = deployment.meta?.githubCommitSha
    if (sha && !commits.includes(sha)) commits.push(sha)
  }
  return commits
}
