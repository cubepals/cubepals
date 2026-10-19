// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type ServerView, versionsThatJoin } from '@blockly/contracts'

/** Which players' games join a server, in a sentence: "Players on Minecraft 1.9 or newer can join." */
export function joinsLine(view: Pick<ServerView, 'gameVersion' | 'joins'>): string {
  const versions = versionsThatJoin(view.gameVersion, view.joins)
  return versions === view.gameVersion
    ? `Only players on Minecraft ${versions} can join.`
    : `Players on Minecraft ${versions} can join.`
}
