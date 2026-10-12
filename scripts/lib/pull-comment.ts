// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GitHub's REST API with the workflow's token, and the one comment a script keeps on a pull
 * request: found by the marker its body opens with and the account that writes it (COMMENT_AUTHOR,
 * the Cubepals app's bot where the workflow has its token, else github-actions[bot]), edited in
 * place, written new only when there is none. Used by preview-comment.ts and ci-comment.ts. It imports nothing, so it runs before
 * `bun install`. Not for what a comment says: each script writes its own.
 */

const need = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** GitHub's answer to `path`, under api.github.com, with GH_TOKEN; it throws on anything but 2xx. */
export async function github(path: string, init: RequestInit = {}): Promise<Response> {
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

/** The account the comments are written as: only its own comment can be edited. */
const author = (): string => process.env.COMMENT_AUTHOR || 'github-actions[bot]'

/** The id of the comment the workflow wrote on the pull request before, found by its marker. */
async function existing(repo: string, pull: number | string, marker: string): Promise<number | undefined> {
  for (let page = 1; ; page++) {
    const response = await github(`repos/${repo}/issues/${pull}/comments?per_page=100&page=${page}`)
    const comments = (await response.json()) as { id: number; body?: string; user?: { login?: string } }[]
    const ours = comments.find(
      (comment) => comment.user?.login === author() && comment.body?.startsWith(marker),
    )
    if (ours) return ours.id
    if (comments.length < 100) return undefined
  }
}

/** Edits the comment that opens with `marker` to `body`, or writes it when there is none yet. */
export async function keepComment(repo: string, pull: number | string, marker: string, body: string) {
  const id = await existing(repo, pull, marker)
  await github(
    id === undefined ? `repos/${repo}/issues/${pull}/comments` : `repos/${repo}/issues/comments/${id}`,
    {
      method: id === undefined ? 'POST' : 'PATCH',
      body: JSON.stringify({ body }),
    },
  )
}
