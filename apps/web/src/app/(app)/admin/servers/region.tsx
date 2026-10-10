// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * One place servers run, one runtime's one region, as the admin servers page shows it: how many
 * of its servers are in each state and what they cost this month, then the servers themselves.
 * The counts cover every server the search found there, the rows only those the page holds.
 */
import type { FleetRegionView, FleetServerView } from '@blockly/contracts'
import { FormSection, StatusPill } from '../../../../ui'
import { ServerRow } from './server-row'
import { countedStates, dollars, placeName } from './words'

export function Region({
  region,
  servers,
  now,
}: {
  region: FleetRegionView
  /** Its servers among those the page holds, newest first. */
  servers: readonly FleetServerView[]
  now: number
}) {
  const left = region.servers - servers.length
  const cost =
    region.month.costCents === null
      ? `${region.month.hours} h this month`
      : `${dollars(region.month.costCents)} this month`
  return (
    <FormSection
      title={placeName(region)}
      description={`${region.servers} ${region.servers === 1 ? 'server' : 'servers'} · ${cost}`}
    >
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
        {countedStates(region.states).map((state) => (
          <StatusPill key={state.key} status={state.pill} label={state.label} />
        ))}
      </div>
      <div className="bk-list">
        {servers.map((server) => (
          <ServerRow key={server.id} server={server} now={now} />
        ))}
        {left > 0 && (
          <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            {left} older {left === 1 ? 'one' : 'ones'} here. Search to find {left === 1 ? 'it' : 'them'}.
          </p>
        )}
      </div>
    </FormSection>
  )
}
