// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Which origins preview-uploads.ts lets put worlds into staging's bucket, and which it takes away. */
import { describe, expect, test } from 'bun:test'
import type { CORSRule } from '@aws-sdk/client-s3'
import { HOUR_S } from '@blockly/contracts/durations'
import { allowing, COMMIT_ORIGIN, closing, PREVIEW_ORIGIN } from './preview-uploads.ts'

const WEB = 'https://staging.cubepals.com'
const preview = (pull: number) => `https://pr-${pull}-blockly-web-staging.cloudflare-c49.workers.dev`
const site: CORSRule = {
  AllowedOrigins: [WEB],
  AllowedMethods: ['GET', 'PUT', 'HEAD'],
  AllowedHeaders: ['*'],
  ExposeHeaders: ['ETag'],
  MaxAgeSeconds: HOUR_S,
}
const other: CORSRule = { AllowedOrigins: ['https://example.com'], AllowedMethods: ['GET'] }

describe('allowing', () => {
  test('adds a preview to the site’s rule and keeps every other rule', () => {
    expect(allowing([other, site], [WEB, preview(7)])).toEqual([
      other,
      { ...site, AllowedOrigins: [WEB, preview(7)] },
    ])
  })

  test('changes nothing when the origin is there already', () => {
    const rules = [{ ...site, AllowedOrigins: [WEB, preview(7)] }]
    expect(allowing(rules, [WEB, preview(7)])).toBe(rules)
  })

  test('makes the upload rule when there are no rules', () => {
    expect(allowing([], [WEB, preview(7), preview(7)])).toEqual([
      { ...site, AllowedOrigins: [WEB, preview(7)] },
    ])
  })

  test('leaves an origin in the rule that already names it', () => {
    expect(allowing([site, other], ['https://example.com', preview(3)])).toEqual([
      site,
      { ...other, AllowedOrigins: ['https://example.com', preview(3)] },
    ])
  })
})

describe('closing', () => {
  const rules = [{ ...site, AllowedOrigins: [WEB, preview(7), preview(8)] }, other]

  test('removes the previews of closed pull requests and nothing else', () => {
    expect(closing(rules, (pull) => pull !== 7)).toEqual([
      { ...site, AllowedOrigins: [WEB, preview(8)] },
      other,
    ])
  })

  test('keeps the same rules when every preview is open', () => {
    const kept = closing(rules, () => true)
    expect(kept[0]).toBe(rules[0])
    expect(kept[1]).toBe(other)
  })

  test('drops a rule left naming nobody', () => {
    expect(closing([{ ...site, AllowedOrigins: [preview(9)] }, other], () => false)).toEqual([other])
  })

  test("takes a commit's origin with its pull request, and one nobody recorded", () => {
    const commit = (sha: string) => `https://${sha}.preview.cubepals.com`
    const commits = new Map([
      ['b226b58', { sha: 'b226b58a0c', pull: 7, at: '2026-10-13T10:00:00.000Z' }],
      ['c0ffee0', { sha: 'c0ffee0a0c', pull: 8, at: '2026-10-13T11:00:00.000Z' }],
    ])
    const named = [
      { ...site, AllowedOrigins: [WEB, commit('b226b58'), commit('c0ffee0'), commit('1234567')] },
    ]
    // Closing pull request 7, an unrecorded commit waits for the sweep.
    expect(closing(named, (pull) => pull !== 7, commits)).toEqual([
      { ...site, AllowedOrigins: [WEB, commit('c0ffee0'), commit('1234567')] },
    ])
    // The sweep, with pull request 8 open, takes it.
    expect(closing(named, (pull) => pull === 8, commits)).toEqual([
      { ...site, AllowedOrigins: [WEB, commit('c0ffee0')] },
    ])
  })

  test('never takes an origin that only looks like a preview', () => {
    const lookalike = 'https://pr-7-blockly-web-staging.cloudflare-c49.workers.dev.evil.example'
    expect(closing([{ ...site, AllowedOrigins: [lookalike] }], () => false)).toHaveLength(1)
  })
})

test('a preview origin names its pull request', () => {
  expect(PREVIEW_ORIGIN.exec(preview(123))?.[1]).toBe('123')
  expect(PREVIEW_ORIGIN.test(WEB)).toBe(false)
  expect(PREVIEW_ORIGIN.test(`${preview(1)}/sign-in`)).toBe(false)
  expect(PREVIEW_ORIGIN.exec('https://pr-45.preview.cubepals.com')?.[1]).toBe('45')
  expect(PREVIEW_ORIGIN.test('https://pr-45.preview.cubepals.com.evil.example')).toBe(false)
  expect(COMMIT_ORIGIN.exec('https://b226b58.preview.cubepals.com')?.[1]).toBe('b226b58')
  expect(COMMIT_ORIGIN.test('https://b226b58a.preview.cubepals.com')).toBe(false)
  expect(COMMIT_ORIGIN.test('https://b226b58.preview.cubepals.com.evil.example')).toBe(false)
})
