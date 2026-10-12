// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one comment on a pull request that names its website preview (web-staging.yml): its state,
 * its address and the pages worth opening, the commit, the run, the Worker's version, and whether
 * staging's control plane answers right now, which signing in on a preview needs, with a link to
 * start it that only maintainers can use (staging.yml).
 *
 *   bun scripts/preview-comment.ts building | ready | failed
 *
 * It reads the rest from the environment the workflow gives it: GH_TOKEN, REPO, PULL, SHA,
 * RUN_URL, and once there is one, URL and VERSION. It edits the comment it wrote before, found by
 * its marker, and writes a new one only when there is none. It needs no installed package, so it
 * can say "building" before `bun install`. Not for building or uploading anything: that is
 * staging-website.ts.
 */
import { API } from './staging-website.ts'

export type PreviewState = 'building' | 'ready' | 'failed'

export interface Preview {
  state: PreviewState
  repo: string
  sha: string
  runUrl: string
  url?: string
  version?: string
  stagingUp: boolean
  now: Date
}

/** The comment's first line, which finds it again. */
export const MARKER = '<!-- web-staging-preview -->'
const BRAND = 'https://raw.githubusercontent.com/cubepals/cubepals/main/brand/png'
const PAGES = ['/', '/pricing', '/sign-in']

const STATE: Record<PreviewState, string> = {
  building: '🔨 Building',
  ready: '✅ Ready',
  failed: '❌ Failed',
}

/** The comment's text, in GitHub's Markdown. */
export function previewComment(preview: Preview): string {
  const { url, version } = preview
  const updated = `${preview.now.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const pages = url ? PAGES.map((page) => `[${page}](${new URL(page, url)})`).join(' · ') : ''
  const where = url ? `[${new URL(url).host}](${url})<br>${pages}` : '—'
  const rows = [
    ['Status', `**${STATE[preview.state]}**`],
    ['Preview', where],
    ['Commit', `[\`${preview.sha.slice(0, 7)}\`](https://github.com/${preview.repo}/commit/${preview.sha})`],
    ['Updated', updated],
    ['Logs', `[Workflow run](${preview.runUrl})`],
    ...(version ? [['Version', `\`${version}\``]] : []),
  ]
  const [head, ...body] = rows.map(([name, value]) => `| **${name}** | ${value} |`)
  return [
    MARKER,
    '<picture>',
    `  <source media="(prefers-color-scheme: dark)" srcset="${BRAND}/lockup-horizontal-reversed.png">`,
    `  <img alt="cubepals" src="${BRAND}/lockup-horizontal.png" height="28">`,
    '</picture>',
    '',
    '**Deployed on Cloudflare Workers**',
    '',
    head,
    '| --- | --- |',
    ...body,
    '',
    preview.stagingUp
      ? 'Staging is running.'
      : `Staging is stopped. To sign in on the preview, a maintainer starts it: [run Staging](https://github.com/${preview.repo}/actions/workflows/staging.yml).`,
    '',
  ].join('\n')
}

/** Whether staging's control plane answers its health check within a few seconds. */
export async function stagingRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(5000) })
    return response.ok
  } catch {
    return false
  }
}

const need = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

async function github(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${need('GH_TOKEN')}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status} to ${init.method ?? 'GET'} ${path}`)
  return response
}

/** The id of the comment this script wrote on the pull request before, if any. */
async function existing(repo: string, pull: string): Promise<number | undefined> {
  for (let page = 1; ; page++) {
    const response = await github(`repos/${repo}/issues/${pull}/comments?per_page=100&page=${page}`)
    const comments = (await response.json()) as { id: number; body?: string; user?: { login?: string } }[]
    const ours = comments.find(
      (comment) => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(MARKER),
    )
    if (ours) return ours.id
    if (comments.length < 100) return undefined
  }
}

if (import.meta.main) {
  const state = process.argv[2]
  if (state !== 'building' && state !== 'ready' && state !== 'failed') {
    process.stdout.write('bun scripts/preview-comment.ts building | ready | failed\n')
    process.exit(2)
  }
  const repo = need('REPO')
  const pull = need('PULL')
  const body = previewComment({
    state,
    repo,
    sha: need('SHA'),
    runUrl: need('RUN_URL'),
    url: process.env.URL || undefined,
    version: process.env.VERSION || undefined,
    stagingUp: await stagingRunning(),
    now: new Date(),
  })
  const id = await existing(repo, pull)
  await github(
    id === undefined ? `repos/${repo}/issues/${pull}/comments` : `repos/${repo}/issues/comments/${id}`,
    {
      method: id === undefined ? 'POST' : 'PATCH',
      body: JSON.stringify({ body }),
    },
  )
}
