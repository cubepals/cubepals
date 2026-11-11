// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The policies hold together: every page has its own path and anchors, every link lands on a page
 * and section that exist, section numbers come from order and never from typing, and no markup is
 * left for a reader to see.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { piecesOf, TOKENS } from './inline.ts'
import { OPERATOR } from './operator.ts'
import { hrefOf, POLICIES, policyAt } from './policies.ts'
import type { Block } from './policy.ts'

/** Every sentence a policy holds: summary, headings, paragraphs, list items and table cells. */
function sentencesOf(policy: (typeof POLICIES)[number]): string[] {
  const ofBlock = (block: Block): string[] =>
    typeof block === 'string'
      ? [block]
      : 'list' in block
        ? [...block.list]
        : 'steps' in block
          ? [...block.steps]
          : [...block.table.head, ...block.table.rows.flat()]
  return [
    policy.description,
    ...policy.summary,
    ...policy.sections.flatMap((section) => [section.heading, ...section.blocks.flatMap(ofBlock)]),
  ]
}

/** Pages a policy may link to besides the policies themselves. */
const PAGES = ['/pricing', '/account']

/** The links on this site a policy holds. */
const linksOf = (policy: (typeof POLICIES)[number]): string[] =>
  sentencesOf(policy)
    .flatMap(piecesOf)
    .flatMap((piece) => (piece.kind === 'link' && piece.href.startsWith('/') ? [piece.href] : []))

/** Whether a link lands on a page that exists, and on a section of it that does. */
function landsOn(href: string): boolean {
  const [path = '', anchor] = href.split('#')
  if (PAGES.includes(path)) return anchor === undefined
  const target = POLICIES.find((p) => hrefOf(p) === path)
  return target !== undefined && (anchor === undefined || target.sections.some((s) => s.id === anchor))
}

describe('the policies', () => {
  test('each has a path of its own, a summary and sections with their own anchors', () => {
    expect(new Set(POLICIES.map((p) => p.slug)).size).toBe(POLICIES.length)
    for (const policy of POLICIES) {
      expect(policyAt(policy.slug)).toBe(policy)
      expect(policy.summary.length).toBeGreaterThan(0)
      const ids = policy.sections.map((s) => s.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  test('every link goes somewhere that exists, down to the section', () => {
    for (const policy of POLICIES)
      for (const href of linksOf(policy)) expect(landsOn(href), `${policy.slug}: ${href}`).toBe(true)
  })

  test('nothing is left as markup: every {token} is one the pages fill in', () => {
    for (const policy of POLICIES)
      for (const sentence of sentencesOf(policy)) {
        for (const unknown of sentence.matchAll(/\{([A-Za-z]+)\}/g))
          expect(TOKENS as readonly string[], `${policy.slug}: ${sentence}`).toContain(unknown[1] ?? '')
        expect(sentence, policy.slug).not.toContain('`')
        expect(sentence, policy.slug).not.toContain('undefined')
      }
  })

  test('accounts are for adults, and every page that needs it says so', () => {
    const all = (slug: string) => {
      const policy = policyAt(slug)
      expect(policy).toBeDefined()
      return policy ? sentencesOf(policy).join(' ') : ''
    }
    expect(all('terms')).toContain('18 or over')
    expect(all('privacy')).toContain('18 and over')
  })

  test('the Terms carry Mojang’s disclaimer, and every mailbox is on the service’s own domain', () => {
    const terms = policyAt('terms')
    expect(terms && sentencesOf(terms).join(' ')).toContain(
      'is not an official Minecraft service. It is not approved by or associated with Mojang or Microsoft.',
    )
    for (const address of Object.values(OPERATOR.emails))
      expect(address.endsWith(`@${OPERATOR.domain}`)).toBe(true)
  })
})

describe('section numbers', () => {
  test('come from a section’s place: no heading is written with one', () => {
    for (const policy of POLICIES)
      for (const { heading } of policy.sections)
        expect(heading, `${policy.slug}: ${heading}`).not.toMatch(/^\s*(§\s*)?\d+[.):]?\s/)
  })

  test('no sentence types one: another section is named by its id, as {§id}', () => {
    for (const policy of POLICIES)
      for (const sentence of sentencesOf(policy))
        expect(sentence, `${policy.slug}: ${sentence}`).not.toMatch(/\bsections?\s+\d|§\s*\d/i)
  })

  test('every {§id} names a section of its own policy', () => {
    for (const policy of POLICIES) {
      const ids = policy.sections.map((s) => s.id)
      for (const piece of sentencesOf(policy).flatMap(piecesOf))
        if (piece.kind === 'section') expect(ids, `${policy.slug}: {§${piece.id}}`).toContain(piece.id)
    }
  })

  test('a description or a heading refers to none: both are shown where sections have no numbers', () => {
    for (const policy of POLICIES)
      for (const sentence of [policy.description, ...policy.sections.map((s) => s.heading)])
        expect(
          piecesOf(sentence).map((piece) => piece.kind),
          `${policy.slug}: ${sentence}`,
        ).not.toContain('section')
  })
})

/** The apps whose source may link to a policy: this web app and the control plane's emails. */
const APPS = join(import.meta.dir, '..', '..', '..')

/** Every `.ts` and `.tsx` file under a directory. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/**
 * A link to a policy written out: after a quote, a markdown link's bracket, this site's address or
 * a template's `}`, so neither an import of a file under `legal/` nor another site's page is one.
 */
const POLICY_LINK = new RegExp(
  `(?:["'\`(]|https?://(?:[\\w-]+\\.)*${OPERATOR.domain.replaceAll('.', '\\.')}|\\})/legal/([a-z-]+)(?:#([\\w-]+))?`,
  'g',
)

describe('links to the policies', () => {
  test('anywhere in the apps, name a policy that exists and a section of it that does', () => {
    const files = ['web/src', 'control/src'].flatMap((dir) => sources(join(APPS, dir)))
    expect(files.length).toBeGreaterThan(0)
    let found = 0
    for (const file of files)
      for (const [link, slug = '', anchor] of readFileSync(file, 'utf8').matchAll(POLICY_LINK)) {
        found++
        const where = `${relative(APPS, file)}: ${link}`
        const policy = policyAt(slug)
        expect(policy, where).toBeDefined()
        if (anchor !== undefined)
          expect(
            policy?.sections.map((s) => s.id),
            where,
          ).toContain(anchor)
      }
    expect(found).toBeGreaterThan(0)
  })
})
