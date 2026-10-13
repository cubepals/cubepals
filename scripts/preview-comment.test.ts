// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** The preview comment's text: its state, address, commits and what staging can do right now. */
import { describe, expect, test } from 'bun:test'
import { MARKER, previewComment } from './preview-comment.ts'

const base = {
  repo: 'cubepals/cubepals',
  sha: 'b226b58a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f',
  runUrl: 'https://github.com/cubepals/cubepals/actions/runs/1',
  now: new Date('2026-10-11T14:02:33Z'),
}
const url = 'https://pr-12-blockly-web-staging.team.workers.dev'

describe('previewComment', () => {
  test('a ready preview: its pages, commit, run and version, and staging running', () => {
    const body = previewComment({ ...base, state: 'ready', url, version: 'abcd-1234', stagingUp: true })
    expect(body.startsWith(MARKER)).toBe(true)
    expect(body).toContain('Deployed on Cloudflare Workers')
    expect(body).toContain('| **Status** | **✅ Ready** |')
    expect(body).toContain(
      `[pr-12-blockly-web-staging.team.workers.dev](${url})<br>[/](${url}/) · [/pricing](${url}/pricing) · [/sign-in](${url}/sign-in)`,
    )
    expect(body).toContain(`[\`b226b58\`](https://github.com/cubepals/cubepals/commit/${base.sha})`)
    expect(body).toContain('| **Updated** | 2026-10-11 14:02 UTC |')
    expect(body).toContain(`[Workflow run](${base.runUrl})`)
    expect(body).toContain('| **Version** | `abcd-1234` |')
    expect(body).toContain('Staging’s API answers, so signing in on the preview works.')
  })

  test('lists the latest five commits, newest first, each at its own address', () => {
    const shas = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) => `${letter.repeat(7)}0123456789`)
    const body = previewComment({ ...base, state: 'ready', url, commits: shas, stagingUp: true })
    const listed = body.split('\n').filter((line) => line.startsWith('- '))
    expect(listed).toHaveLength(5)
    expect(listed[0]).toBe(
      `- [\`aaaaaaa\`](https://github.com/cubepals/cubepals/commit/${shas[0]}) · [aaaaaaa.preview.cubepals.com](https://aaaaaaa.preview.cubepals.com)`,
    )
    expect(listed[4]).toContain('[eeeeeee.preview.cubepals.com](https://eeeeeee.preview.cubepals.com)')
    expect(body).not.toContain('fffffff')
    expect(body.indexOf('| **Preview** |')).toBeLessThan(body.indexOf('Each commit at its own address'))
  })

  test('while building: no address yet, no version, and staging stopped', () => {
    const body = previewComment({ ...base, state: 'building', stagingUp: false })
    expect(body).toContain('| **Status** | **🔨 Building** |')
    expect(body).toContain('| **Preview** | — |')
    expect(body).not.toContain('Version')
    expect(body).not.toContain('Each commit')
    expect(body).toContain('Staging’s API didn’t answer yet. It wakes when the preview is opened.')
    expect(body).toContain(
      'Mail and game servers need all of staging, which a maintainer starts: [run Staging](https://github.com/cubepals/cubepals/actions/workflows/staging.yml).',
    )
  })
})
