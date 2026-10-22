// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a deployment doesn't let Bedrock players in, the settings page has no Bedrock section, not
 * even the note that they can't join this kind of server, and the invite box keeps its Java-only line.
 */

import { describe, expect, test } from 'bun:test'
import { letsBedrockIn, type ServerView } from '@blockly/contracts'
import { joinLine } from '../../../../../lib/present'
import { BedrockSetting } from './bedrock'

const view = (offered: boolean, bedrock: Exclude<ServerView['bedrock'], false>) =>
  ({ bedrock: offered ? bedrock : false }) as ServerView

describe('a deployment without Bedrock', () => {
  test('the settings page has no Bedrock section, on a Paper server or any other', () => {
    expect(BedrockSetting({ view: view(false, null) })).toBeNull()
    expect(
      BedrockSetting({ view: view(false, { on: true, needsOtherVersions: false, moves: false }) }),
    ).toBeNull()
  })

  test('the invite box keeps today’s line', () => {
    expect(letsBedrockIn(view(false, null))).toBe(false)
    expect(joinLine('26.2', null, null, letsBedrockIn(view(false, null)))).toBe(joinLine('26.2'))
    expect(joinLine('26.2')).toContain('Consoles and phones can’t join.')
  })

  test('where it is offered, a server that cannot have Bedrock still gets the note', () => {
    expect(BedrockSetting({ view: view(true, null) })).not.toBeNull()
  })
})
