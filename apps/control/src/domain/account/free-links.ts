// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How sure Blockly is that free accounts are one person's: each server's main player, a score for
 * each pair of accounts from what they have in common, the groups those scores join into, and what
 * a group's confidence lets Blockly do. Pure: the facts come from `app/accounts/free-links.ts`,
 * which also writes what is decided here.
 */
import { paidForPlayer } from './free-play.ts'
import type { FreeLinkTuning, LinkSignals } from './tuning.ts'

/**
 * The signals a pair is scored on, each in [0, 1]:
 *
 * - `mainPlayer`: one Minecraft account is the main player of a server on each (`mainPlayer`),
 *   scaled by its share of the play on both (their geometric mean);
 * - `inbox`: both emails reach one inbox (`emailKey`), 1 or 0;
 * - `signedUpClose`: how close together they signed up, 1 at once, falling to 0 over
 *   `signedUpCloseMs`;
 * - `network`: they signed up from one network (`addressKey`), 1 or 0, known for `networkKeptMs`;
 * - `playersMoved`: the later one signed up within `movedWithinMs` of the earlier one's players
 *   being turned away for its free hours, and they have at least `movedPlayers` players in
 *   common, as a share of the fewer either has (`playersMoved`).
 *
 * A pair's score is their weighted sum, held to 1, the weights a deployment's own
 * (`FreeLinkTuning`). A pair at `link` or more joins its accounts' group, and the group's
 * confidence sets one of three levels: under `medium`, nothing happens; from `medium`, admins see
 * it under Linked accounts and in the alert inbox, and nothing changes for the accounts; from
 * `high`, the later accounts share the first one's free hours. The signals in `SHOWN_ONLY` can
 * take a group as far as `medium`, never to `high`: friends who each run a server for the same
 * group look the same, so whether those accounts are one person's is an admin's call.
 */
export const NO_SIGNALS: LinkSignals = {
  mainPlayer: 0,
  inbox: 0,
  signedUpClose: 0,
  network: 0,
  playersMoved: 0,
}

/** Signals that show a pair to admins and never, on their own, make its accounts share hours. */
const SHOWN_ONLY: ReadonlyArray<keyof LinkSignals> = ['playersMoved']

export type Confidence = 'low' | 'medium' | 'high'

/** A pair's score: the weighted sum of its signals, held to [0, 1]. */
export function linkScore(signals: LinkSignals, tuning: FreeLinkTuning): number {
  let sum = 0
  for (const key of Object.keys(tuning.weights) as Array<keyof LinkSignals>)
    sum += tuning.weights[key] * Math.min(1, Math.max(0, signals[key] ?? 0))
  return Math.min(1, sum)
}

/** A pair's score from the signals that may make accounts share hours: all but `SHOWN_ONLY`. */
export const sharingScore = (signals: LinkSignals, tuning: FreeLinkTuning): number =>
  linkScore({ ...signals, ...Object.fromEntries(SHOWN_ONLY.map((key) => [key, 0])) }, tuning)

/**
 * The `playersMoved` signal from the players each account's servers have, the earlier's and the
 * later's, when the later signed up soon after the earlier ran out: the players they have in
 * common as a share of the fewer either has, or 0 under `movedPlayers` in common.
 */
export function playersMoved(
  earlier: ReadonlySet<string>,
  later: ReadonlySet<string>,
  tuning: FreeLinkTuning,
): number {
  let common = 0
  for (const uuid of later) if (earlier.has(uuid)) common++
  if (common < tuning.movedPlayers) return 0
  return common / Math.min(earlier.size, later.size)
}

/** How close two sign-ups were, as `signedUpClose` counts it. */
export const signedUpClose = (a: Date, b: Date, tuning: FreeLinkTuning): number =>
  Math.max(0, 1 - Math.abs(a.getTime() - b.getTime()) / tuning.signedUpCloseMs)

/** The `mainPlayer` signal for two servers whose main player is the same, from its share on each. */
export const sameMain = (shareA: number, shareB: number): number => Math.sqrt(shareA * shareB)

/**
 * The player a server is run for, from each player's verified play on it in seconds: a Minecraft
 * account (`paidForPlayer`) with at least `mainShare` of it and `mainForS`, and more than anyone
 * else. Null when nobody is, as when friends play alike.
 */
export function mainPlayer(
  seconds: ReadonlyMap<string, number>,
  tuning: FreeLinkTuning,
): { uuid: string; share: number } | null {
  let total = 0
  let top: { uuid: string; seconds: number } | null = null
  let second = 0
  for (const [uuid, s] of seconds) {
    total += s
    if (top === null || s > top.seconds) {
      second = top?.seconds ?? 0
      top = { uuid, seconds: s }
    } else second = Math.max(second, s)
  }
  if (top === null || total === 0 || top.seconds === second) return null
  const share = top.seconds / total
  if (!paidForPlayer(top.uuid) || share < tuning.mainShare || top.seconds < tuning.mainForS) return null
  return { uuid: top.uuid, share }
}

/** A scored pair of accounts. */
export interface ScoredPair {
  a: string
  b: string
  score: number
  /** Its `sharingScore`; the score itself when absent. */
  sharing?: number
}

/** Accounts that are one person's as far as Blockly can tell, the first to sign up first. */
export interface LinkedGroup {
  members: string[]
  confidence: number
  level: Confidence
}

export const levelOf = (confidence: number, tuning: FreeLinkTuning): Confidence =>
  confidence >= tuning.high ? 'high' : confidence >= tuning.medium ? 'medium' : 'low'

/**
 * The groups linked pairs join accounts into: union-find over the pairs at `link` or above,
 * strongest first, so the links that join a group are its strongest ones (a maximum spanning
 * tree). A group's confidence is the chance at least one of those links is right, read as
 * independent: 1 − Π(1 − score). So a group grows surer with each account that links into it, and
 * no weaker than its strongest link. `createdAt` orders each group's members, the first first.
 *
 * Which accounts share hours is settled on the sharing scores alone: the groups they make that
 * reach `high` are kept as they are, whatever a shown-only link adds. The accounts left over are
 * grouped on the full scores, held under `high`, so a shown-only link shows them and shares nothing.
 */
export function linkedGroups(
  pairs: readonly ScoredPair[],
  createdAt: ReadonlyMap<string, Date>,
  tuning: FreeLinkTuning,
): LinkedGroup[] {
  const made = (id: string) => createdAt.get(id)?.getTime() ?? Number.POSITIVE_INFINITY
  const group = (ids: string[], confidence: number): LinkedGroup => ({
    members: ids.sort((x, y) => made(x) - made(y) || x.localeCompare(y)),
    confidence,
    level: levelOf(confidence, tuning),
  })
  const sharingPairs = pairs.map((p) => ({ ...p, score: Math.min(p.score, p.sharing ?? p.score) }))
  const sharing = spanningGroups(sharingPairs, tuning).filter((g) => g.confidence >= tuning.high)
  const shares = new Set(sharing.flatMap((g) => g.ids))
  // The most a group that shares nothing is shown with.
  const shownAtMost = Math.max(tuning.medium, tuning.high - 0.01)
  const shown = spanningGroups(pairs, tuning).flatMap(({ ids, confidence }) => {
    const left = ids.filter((id) => !shares.has(id))
    return left.length === 0 ? [] : [group(left, Math.min(confidence, shownAtMost))]
  })
  return [...sharing.map(({ ids, confidence }) => group(ids, confidence)), ...shown]
}

/** The maximum spanning trees of the pairs at `link` or above, each with its confidence. */
function spanningGroups(
  pairs: readonly ScoredPair[],
  tuning: FreeLinkTuning,
): Array<{ ids: string[]; confidence: number }> {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string
    parent.set(id, root)
    return root
  }
  const doubt = new Map<string, number>()
  for (const pair of [...pairs].filter((p) => p.score >= tuning.link).sort((x, y) => y.score - x.score)) {
    const ra = find(pair.a)
    const rb = find(pair.b)
    if (ra === rb) continue
    parent.set(rb, ra)
    doubt.set(ra, (doubt.get(ra) ?? 1) * (doubt.get(rb) ?? 1) * (1 - pair.score))
    doubt.delete(rb)
  }
  const members = new Map<string, string[]>()
  for (const id of parent.keys()) members.set(find(id), [...(members.get(find(id)) ?? []), id])
  return [...members].map(([root, ids]) => ({ ids, confidence: 1 - (doubt.get(root) ?? 1) }))
}
