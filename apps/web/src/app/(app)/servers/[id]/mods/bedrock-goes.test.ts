// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Adding a server's first mod says, before it applies, that Bedrock friends can't join once it
 * has mods: only where they join it now, and only where the change moves it off Paper.
 */

import { describe, expect, test } from 'bun:test'
import type { BedrockView, Loader } from '@blockly/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { BedrockGoes } from './bedrock-goes'

const takes: BedrockView = { on: true, needsOtherVersions: false, moves: false }
const said = (bedrock: BedrockView | null | false, loader: Loader, added: readonly string[] = ['Sodium']) => {
  const line = BedrockGoes({ view: { bedrock }, plan: { loader, added } })
  return line === null ? null : renderToStaticMarkup(line)
}

describe('the first mod on a server Bedrock friends join', () => {
  test('says they won’t be able to join once it has mods', () => {
    expect(said(takes, 'fabric')).toContain(
      'Bedrock friends (phones, tablets and Windows) won’t be able to join',
    )
    expect(said(takes, 'neoforge')).not.toBeNull()
  })

  test('says nothing where the server stays on Paper or plain Minecraft', () => {
    expect(said(takes, 'paper')).toBeNull()
    expect(said(takes, 'vanilla')).toBeNull()
  })

  test('says nothing for a change that adds nothing, such as removing or updating', () => {
    expect(said(takes, 'fabric', [])).toBeNull()
  })

  test('says nothing where Bedrock friends can’t join it already', () => {
    expect(said({ ...takes, on: false }, 'fabric')).toBeNull()
    expect(said({ ...takes, needsOtherVersions: true }, 'fabric')).toBeNull()
    expect(said(null, 'fabric')).toBeNull()
    expect(said(false, 'fabric')).toBeNull()
  })
})
