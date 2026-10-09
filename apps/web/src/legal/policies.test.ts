/**
 * The policies hold together: every page has its own path and anchors, every link lands on a page
 * and section that exist, and no markup is left for a reader to see.
 */
import { describe, expect, test } from 'bun:test'
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
