// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { TemplateCredits } from '@blockly/contracts'
import { Fragment } from 'react'

/**
 * Who made the published maps a server's world is built on, as its page says it after the
 * description: one small, quiet line, each maker linked to where they publish the maps. It comes
 * from the template the world was made from, never from what an owner writes.
 */
export function MapCredits({ credits }: { credits: TemplateCredits }) {
  const last = credits.makers.length - 1
  return (
    <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
      Built on maps by{' '}
      {credits.makers.map((maker, i) => (
        <Fragment key={maker.name}>
          {i === 0 ? '' : i === last ? ' and ' : ', '}
          {maker.article === undefined ? '' : `${maker.article} `}
          <a href={maker.url} target="_blank" rel="noreferrer">
            {maker.name}
          </a>
        </Fragment>
      ))}
      .
    </p>
  )
}
