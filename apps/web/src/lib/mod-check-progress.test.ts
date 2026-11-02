// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** An unknown check has elapsed time, while completed check time stays separate from the boot estimate. */
import { expect, test } from 'bun:test'
import type { OperationView, ServerView } from '@blockly/contracts'
import { SECOND_MS } from '@blockly/contracts/durations'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProvisioningPanel } from '../ui/status'
import { etaLine, presentProgress, quietLine, wakeLine } from './present'

const operation = {
  id: 'check',
  kind: 'start',
  change: null,
  worldBytes: null,
  broughtWorld: null,
  status: 'running',
  step: 'checking_mods',
  error: null,
  createdAt: '2026-11-02T00:00:00Z',
  startedAt: '2026-11-02T00:00:00Z',
  modCheckSeconds: null,
} satisfies OperationView
const server = {
  name: 'Life',
  modCount: 11,
  modpack: null,
  gameVersion: '26.3',
  lastWakeSeconds: 2,
  activeOperation: operation,
} as ServerView

test('the check shows elapsed time without a fabricated countdown or completion bar', () => {
  const progress = presentProgress(operation, server)
  if (!progress) throw new Error('The compatibility check needs progress')
  expect(progress.expectedSeconds).toBeNull()
  expect(progress.steps[0]).toMatchObject({ state: 'active', indeterminate: true })
  const now = Date.parse(operation.startedAt) + 90 * SECOND_MS
  expect(etaLine(operation.startedAt, null, now)).toBe('90s elapsed')
  expect(wakeLine(server, now)).toContain('90s elapsed')
  expect(quietLine('checking_mods', server)).toContain('Testing these mods together')
  const html = renderToStaticMarkup(
    createElement(ProvisioningPanel, { title: progress.title, progress: 80, steps: progress.steps }),
  )
  expect(html).not.toContain('role="progressbar"')
  expect(html).toContain('Testing these mods together')
})

test('a completed check adds its measured time to the existing estimate', () => {
  const base = { ...operation, step: 'starting' as const, modCheckSeconds: undefined }
  const without = presentProgress(base, server)
  const completed = presentProgress({ ...base, modCheckSeconds: 91 }, server)
  expect(completed?.expectedSeconds).toBe((without?.expectedSeconds ?? 0) + 91)
  expect(etaLine(null, null, 0)).toBe('0s elapsed')
})
