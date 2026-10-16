// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { ServerView } from '@blockly/contracts'

/** Which players' games join a server, in a sentence: "Players on Minecraft 1.9 to 26.2 and newer can join." */
export function joinsLine(view: Pick<ServerView, 'gameVersion' | 'joins'>): string {
  const joins = view.joins
  if (joins === null || (joins.oldest === view.gameVersion && !joins.newer))
    return `Only players on Minecraft ${view.gameVersion} can join.`
  const range =
    joins.oldest === view.gameVersion ? view.gameVersion : `${joins.oldest} to ${view.gameVersion}`
  return `Players on Minecraft ${range}${joins.newer ? ' and newer' : ''} can join.`
}
