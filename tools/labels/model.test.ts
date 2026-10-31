// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Optional model labelling falls back immediately when the SDK receives a provider 429. */
import { expect, spyOn, test } from 'bun:test'
import { type Answer, ask, type Item, MODEL, render } from './model.ts'

test('a provider 429 uses the rule labels without retrying or printing provider details', async () => {
  const before = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'test-key'
  const fetcher = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json(
      { type: 'error', error: { type: 'rate_limit_error', message: 'Private provider details' } },
      { status: 429 },
    ),
  )
  const notice = spyOn(console, 'warn').mockImplementation(() => {})
  const item: Item = {
    type: 'issue',
    title: 'A server does not start',
    body: '',
    rules: { kind: 'kind/bug', impact: 'impact/players' },
  }
  try {
    expect(await ask(item)).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(notice).toHaveBeenCalledWith('::notice::Automated labels unavailable. Using rule-based labels.')
  } finally {
    fetcher.mockRestore()
    notice.mockRestore()
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = before
  }
})

test('model success and other failures retain the existing label behaviour', async () => {
  const before = process.env.ANTHROPIC_API_KEY
  const item: Item = {
    type: 'issue',
    title: 'A server does not start',
    body: '',
    rules: { kind: 'kind/bug', impact: 'impact/players' },
  }
  const fetcher = spyOn(globalThis, 'fetch')
  const notice = spyOn(console, 'warn').mockImplementation(() => {})
  const answer: Answer = { kind: 'kind/bug', impact: 'impact/players', areas: ['area/control'] }
  const response = (content: unknown[]) =>
    Response.json({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  try {
    delete process.env.ANTHROPIC_API_KEY
    expect(await ask(item)).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    process.env.ANTHROPIC_API_KEY = 'test-key'
    fetcher.mockResolvedValue(response([{ type: 'text', text: JSON.stringify(answer) }]))
    expect(await ask(item)).toEqual(answer)
    fetcher.mockResolvedValue(response([]))
    expect(await ask(item)).toBeNull()
    fetcher.mockResolvedValue(
      Response.json({ type: 'error', error: { type: 'api_error', message: 'unavailable' } }, { status: 503 }),
    )
    expect(await ask(item)).toBeNull()
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("the rules' labels stand"))
  } finally {
    fetcher.mockRestore()
    notice.mockRestore()
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = before
  }
})

test('the model sees bounded change data and the rule choices', () => {
  const base: Item = {
    type: 'pull request',
    title: 'Fix a server',
    body: 'a'.repeat(5000),
    rules: { kind: 'kind/bug', impact: 'impact/players' },
  }
  expect(render(base)).toContain(`${'a'.repeat(4000)}</body>`)
  expect(
    render({ ...base, files: [{ path: 'apps/control/service.ts', lines: 3 }], areas: ['area/control'] }),
  ).toContain('apps/control/service.ts (3)')
  expect(
    render({ ...base, files: Array.from({ length: 151 }, (_, i) => ({ path: `file${i}.ts`, lines: 1 })) }),
  ).toContain('…and 1 more')
})
