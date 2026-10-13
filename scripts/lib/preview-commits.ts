// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which Worker version each previewed commit was uploaded as, kept in the Workers KV namespace
 * the previews' router reads (apps/web/preview-router.ts) to put <sha7>.preview.cubepals.com on
 * that version's own preview URL, `<prefix>-blockly-web-staging.<subdomain>.workers.dev`. One key
 * a commit, its first seven characters; its value is the version's prefix, and its metadata says
 * the pull request, the whole commit and when, for the comment's list and the clean-up.
 *
 * staging-website.ts makes the namespace when it is missing and records each upload;
 * preview-comment.ts lists a pull request's commits; preview-commits.ts forgets closed pull
 * requests' commits, and preview-uploads.ts reads which commit is whose for the bucket's CORS
 * rules. Everything goes through Cloudflare's API with the Workers token, which needs Workers KV
 * Storage: Edit. It imports nothing, so the comment can use it before `bun install`.
 */

/** The namespace's title, on the account the previews are uploaded to. */
const COMMITS_NAMESPACE = 'blockly-web-previews-commits'

interface Cloudflare {
  token: string
  accountId: string
}

/** One previewed commit, as its key and metadata hold it. */
export interface PreviewCommit {
  sha: string
  pull: number
  /** When it was uploaded, as an ISO time. */
  at: string
}

interface Answer<T> {
  success: boolean
  result: T
  result_info?: { cursor?: string }
  errors: { code?: number; message: string }[]
}

async function kv<T>(cloudflare: Cloudflare, path: string, init: RequestInit = {}): Promise<Answer<T>> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cloudflare.accountId}/storage/kv/namespaces${path}`,
    {
      ...init,
      headers: { authorization: `Bearer ${cloudflare.token}`, 'content-type': 'application/json' },
    },
  )
  const answer = (await response.json()) as Answer<T>
  if (!answer.success) {
    const why = answer.errors.map((error) => error.message).join('; ')
    throw new Error(
      response.status === 403
        ? `Cloudflare refused the Workers token Workers KV (${why}): it needs Workers KV Storage: Edit`
        : `Cloudflare KV ${init.method ?? 'GET'} ${path || '/'}: ${why}`,
    )
  }
  return answer
}

/** The namespace's id, or undefined when there is none. */
export async function findCommits(cloudflare: Cloudflare): Promise<string | undefined> {
  for (let page = 1; ; page++) {
    const { result } = await kv<{ id: string; title: string }[]>(cloudflare, `?per_page=100&page=${page}`)
    const found = result.find((namespace) => namespace.title === COMMITS_NAMESPACE)
    if (found) return found.id
    if (result.length < 100) return undefined
  }
}

/** The namespace's id, made first when it is missing. Two runs making it at once get the same one. */
export async function commitsNamespace(cloudflare: Cloudflare): Promise<string> {
  const existing = await findCommits(cloudflare)
  if (existing) return existing
  try {
    const { result } = await kv<{ id: string }>(cloudflare, '', {
      method: 'POST',
      body: JSON.stringify({ title: COMMITS_NAMESPACE }),
    })
    return result.id
  } catch (error) {
    const made = await findCommits(cloudflare)
    if (made) return made
    throw error
  }
}

/** Records that `commit` is the version whose preview URL starts with `prefix`. */
export async function recordCommit(
  cloudflare: Cloudflare,
  namespace: string,
  commit: PreviewCommit,
  prefix: string,
): Promise<void> {
  await kv(cloudflare, `/${namespace}/bulk`, {
    method: 'PUT',
    body: JSON.stringify([{ key: commit.sha.slice(0, 7), value: prefix, metadata: commit }]),
  })
}

/** Every recorded commit, by its key. */
export async function listCommits(
  cloudflare: Cloudflare,
  namespace: string,
): Promise<Map<string, PreviewCommit>> {
  const commits = new Map<string, PreviewCommit>()
  let cursor = ''
  do {
    const answer = await kv<{ name: string; metadata?: PreviewCommit }[]>(
      cloudflare,
      `/${namespace}/keys?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    )
    for (const key of answer.result) if (key.metadata) commits.set(key.name, key.metadata)
    cursor = answer.result_info?.cursor ?? ''
  } while (cursor)
  return commits
}

/** A pull request's commits, newest first. */
export function commitsOf(commits: Map<string, PreviewCommit>, pull: number): PreviewCommit[] {
  return [...commits.values()]
    .filter((commit) => commit.pull === pull)
    .sort((a, b) => b.at.localeCompare(a.at))
}

/** Forgets every commit whose pull request `open` turns down, and says how many went. */
export async function forgetCommits(
  cloudflare: Cloudflare,
  namespace: string,
  open: (pull: number) => boolean,
): Promise<number> {
  const closed = [...(await listCommits(cloudflare, namespace))].filter(([, commit]) => !open(commit.pull))
  for (const [key] of closed) await kv(cloudflare, `/${namespace}/values/${key}`, { method: 'DELETE' })
  return closed.length
}
