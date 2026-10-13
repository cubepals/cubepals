// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A commit message or pull request names nobody by accident. GitHub turns `@name` into a mention
 * and notifies whoever owns that name, and commits don't render markdown, so even a backticked
 * Minecraft selector like `@s` pings a real account. Pull requests are squash-merged and the body
 * becomes the commit's, so the title and body are held to the same rule.
 *
 *   bun run scripts/check-mentions.ts <message file>   lefthook's commit-msg hook
 *   bun run scripts/check-mentions.ts --pr             CI, with PR_TITLE and PR_BODY set
 *
 * Email addresses and anything inside `<...>` (trailers like Co-authored-by) aren't mentions.
 * Commits by a bot pass as they are. It doesn't look at issues or comments, which render markdown.
 */
import { readFileSync } from 'node:fs'

/** `@name` or `@org/team` where GitHub would link it: not after a letter, digit or address char. */
const MENTION = /(?<![\p{L}\p{N}._%+\-@\]\\])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(\/[A-Za-z0-9_-]+)?/gu
const BRACKETED = /<[^<>\n]*>/g

/** The mentions GitHub would make of this text, each as written. */
export function mentionsIn(text: string): string[] {
  let kept = text
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
  // Until nothing changes, so a bracket left by one pass can't hide a mention from the next.
  for (let before = ''; before !== kept; ) {
    before = kept
    kept = kept.replace(BRACKETED, ' ')
  }
  return [...kept.matchAll(MENTION)].map((match) => match[0])
}

function byBot(): boolean {
  const author = Bun.spawnSync(['git', 'var', 'GIT_AUTHOR_IDENT'], { stderr: 'ignore' })
  return author.stdout.toString().includes('[bot]')
}

if (import.meta.main) {
  const [arg] = process.argv.slice(2)
  if (!arg) {
    console.error('usage: check-mentions.ts <message file> | --pr')
    process.exit(2)
  }
  const pr = arg === '--pr'
  if (!pr && byBot()) process.exit(0)
  const text = pr ? `${process.env.PR_TITLE ?? ''}\n${process.env.PR_BODY ?? ''}` : readFileSync(arg, 'utf8')
  const found = [...new Set(mentionsIn(text))]
  if (found.length > 0) {
    console.error(`${pr ? 'Pull request' : 'Commit message'} mentions ${found.join(', ')}.`)
    console.error(
      'GitHub would notify whoever owns that name, even inside backticks in a commit. Write it without the at sign, e.g. "the s selector".',
    )
    process.exit(1)
  }
}
