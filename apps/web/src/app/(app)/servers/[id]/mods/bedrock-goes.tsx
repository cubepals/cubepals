// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { type Loader, letsBedrockIn, type ServerView } from '@blockly/contracts'
import { Note } from '../../../../../ui'

/**
 * The line a mod change's confirmation adds where it leaves Bedrock friends out: the server takes
 * them now, and the change adds something that moves it off Paper and plain Minecraft, to the
 * plan's loader.
 */
export function BedrockGoes({
  view,
  plan,
}: {
  view: Pick<ServerView, 'bedrock'>
  plan: { loader: Loader; added: readonly unknown[] }
}) {
  if (!letsBedrockIn(view) || plan.added.length === 0 || plan.loader === 'paper' || plan.loader === 'vanilla')
    return null
  return (
    <Note tone="info">
      Bedrock friends (phones, tablets and Windows) won’t be able to join once it has mods.
    </Note>
  )
}
