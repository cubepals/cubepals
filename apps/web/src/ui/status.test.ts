// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Server status stays named, and an unmeasured compatibility check never renders a numeric progress bar. */
import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProvisioningPanel, type ProvisioningStep, StatusPill } from './status'

test('status pills name ordinary and starting states and honor a specific notice', () => {
  const render = (status: 'online' | 'starting' | 'settingUp' | 'info', label?: string) =>
    renderToStaticMarkup(createElement(StatusPill, { status, label }))
  expect(render('online')).toContain('Online')
  expect(render('online')).not.toContain('bk-status--pulse')
  expect(render('starting')).toContain('bk-status--pulse')
  expect(render('settingUp')).toContain('Setting up')
  expect(render('settingUp')).toContain('bk-status--pulse')
  expect(render('info', 'Checking mods')).toContain('Checking mods')
  expect(render('info', 'Checking mods')).not.toContain('Notice')
})

test('only a measured current stage exposes a numeric completion fraction', () => {
  const render = (steps: ProvisioningStep[], progress?: number) =>
    renderToStaticMarkup(
      createElement(
        ProvisioningPanel,
        {
          title: 'Preparing the server',
          heading: 'h2',
          progress,
          steps,
          eta: 'Checking mods',
          live: 'Working',
        },
        'Your world is kept',
      ),
    )
  const unknown = [{ label: 'Checking mods', state: 'active' as const, indeterminate: true }]
  expect(render(unknown, 60)).not.toContain('role="progressbar"')
  expect(render(unknown)).not.toContain('aria-valuenow')
  expect(render(unknown)).toContain('Working')
  expect(render(unknown)).toContain('Your world is kept')
  const measured = render(
    [
      { label: 'Checking mods', state: 'done', indeterminate: true },
      { label: 'Starting', state: 'active' },
    ],
    60,
  )
  expect(measured).toContain('aria-valuenow="60"')
  expect(measured).toContain('(done)')
  expect(measured).toContain('(now)')
})
