// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a server's page says of a file Cubepals set aside for a start (`set-aside.tsx`): what was
 * moved, why, and that a copy is kept; or, once its owner asked it back, when it goes back.
 */
import type { ServerView } from '@blockly/contracts'

type SetAside = NonNullable<ServerView['setAside']>[number]

/** A file by the name its owner knows it by, and where it was. */
function named(file: SetAside): string {
  const name = file.path.replace(/^.*\//, '')
  return file.inWorld
    ? `the datapack ${name.replace(/\.zip$/i, '')} from its world`
    : `${name} from its mods folder`
}

/** The line for one file set aside. */
export function setAsideLine(file: SetAside): string {
  if (file.back) return `Cubepals puts ${named(file)} back at the server’s next start.`
  return `Cubepals set ${named(file)} aside, a copy kept, because it stopped the server as it started: ${file.why}`
}
