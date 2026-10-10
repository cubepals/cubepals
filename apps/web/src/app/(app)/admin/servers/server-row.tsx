'use client'

/**
 * One server in the admin list. Closed, it says what an admin scans for: its name and address,
 * whose it is, how it is, who plays and what it costs this month. Opened, it shows where the
 * provider holds it and the actions an admin can take on it (`../server-actions.tsx`).
 */
import type { FleetServerView } from '@blockly/contracts'
import Link from 'next/link'
import { useState } from 'react'
import { whenTaken } from '../../../../lib/present'
import { StatusPill } from '../../../../ui'
import { ServerActions } from '../server-actions'
import { dollars, placeName, stateOf } from './words'

export function ServerRow({ server, now }: { server: FleetServerView; now: number }) {
  const [open, setOpen] = useState(false)
  const state = stateOf(server)
  const body = `fleet-${server.id}`
  return (
    <div className="bk-fleetrow">
      <button
        type="button"
        className="bk-fleetrow__head"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen(!open)}
      >
        <span className="bk-fleetrow__main">
          <span className="bk-fleetrow__name">
            {server.name}
            <StatusPill status={state.pill} label={state.label} />
          </span>
          <span className="bk-fleetrow__addr">{server.address}</span>
          <span className="bk-fleetrow__meta">
            {server.owner.name || server.owner.email} · {server.owner.plan} · {server.size} ·{' '}
            <Players server={server} now={now} />
          </span>
        </span>
        <span className="bk-fleetrow__cost">
          {server.month.costCents === null ? `${server.month.hours} h` : dollars(server.month.costCents)}
        </span>
      </button>
      {open && (
        <div id={body} className="bk-fleetrow__body">
          <Facts server={server} />
          <ServerActions server={server} />
        </div>
      )}
    </div>
  )
}

/** Who is on now while it runs; otherwise when someone last was. */
function Players({ server, now }: { server: FleetServerView; now: number }) {
  if (server.status === 'running' && !server.deleted)
    return <>{server.online === 0 ? 'nobody on' : `${server.online} on now`}</>
  if (server.lastPlayedAt === null) return <>never played</>
  const when = whenTaken(server.lastPlayedAt, now)
  return <>last played {when.replace(/^(Today|Yesterday)/, (day) => day.toLowerCase())}</>
}

function Facts({ server }: { server: FleetServerView }) {
  const runtime = server.runtime
  return (
    <dl className="bk-fleetrow__facts">
      <dt>Owner</dt>
      <dd>
        <Link href={`/admin/accounts/${server.owner.userId}`}>{server.owner.name || server.owner.email}</Link>
        {server.owner.name ? ` · ${server.owner.email}` : ''}
      </dd>
      <dt>Runs on</dt>
      <dd>
        {runtime === null ? 'Nothing yet' : placeName({ provider: runtime.provider, region: server.region })}
        {runtime && !runtime.runs && ', which this deployment doesn’t run'}
        {runtime?.moveTo && `, moving to ${runtime.moveTo}`}
      </dd>
      <dt>This month</dt>
      <dd className="bk-num">
        {server.month.hours} h{server.month.costCents === null ? '' : ` · ${dollars(server.month.costCents)}`}
      </dd>
      <dt>At the provider</dt>
      <dd>
        {server.provider === null ? (
          'Nothing there yet'
        ) : (
          <>
            <span className="type-mono-sm">
              {server.provider.names.map((name) => `${name.label} ${name.value}`).join(' · ')}
            </span>
            {server.provider.link && (
              <>
                {' '}
                <a href={server.provider.link} target="_blank" rel="noreferrer">
                  Open there
                </a>
              </>
            )}
          </>
        )}
      </dd>
      <dt>Id</dt>
      <dd className="type-mono-sm">{server.id}</dd>
    </dl>
  )
}
