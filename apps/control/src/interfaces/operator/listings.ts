// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browse, as operators steer it under `/ops/v1`: a server published there or unlisted, as its
 * owner does from Share; the "Run by Cubepals" mark set or cleared with why, and the listing
 * allowlist read, added to and taken from, as admins do. Each route calls the service the web's own
 * route calls, as the operator, so the audit log says `operator:<name>`.
 */
import { MarkOfficialInput, SetPublicInput, TrustProjectInput, UntrustProjectInput } from '@blockly/contracts'
import type { Hono } from 'hono'
import type { ListingQueries } from '../../app/listings/queries.ts'
import type { ListingService } from '../../app/listings/service.ts'
import { bodyOf, OPS_BASE, operatorOf } from './gate.ts'

export interface ListingsOptions {
  listings: Pick<ListingService, 'setPublic' | 'markOfficial' | 'trustProject' | 'untrustProject'>
  listingQueries: Pick<ListingQueries, 'own' | 'allowlist'>
}

const PublicBody = SetPublicInput.omit({ serverId: true })
const OfficialBody = MarkOfficialInput.omit({ serverId: true })

export function listingRoutes(app: Hono, { listings, listingQueries }: ListingsOptions): void {
  app.get(`${OPS_BASE}/servers/:id/listing`, async (c) =>
    c.json({ listing: await listingQueries.own(operatorOf(c), c.req.param('id')) }),
  )
  app.put(`${OPS_BASE}/servers/:id/listing`, async (c) => {
    const operator = operatorOf(c)
    await listings.setPublic(operator, c.req.param('id'), PublicBody.parse(await bodyOf(c)).public)
    return c.json({ listing: await listingQueries.own(operator, c.req.param('id')) })
  })
  app.put(`${OPS_BASE}/servers/:id/official`, async (c) => {
    const operator = operatorOf(c)
    const { official, reason } = OfficialBody.parse(await bodyOf(c))
    await listings.markOfficial(operator, c.req.param('id'), official, reason)
    return c.json({ listing: await listingQueries.own(operator, c.req.param('id')) })
  })

  app.get(`${OPS_BASE}/allowlist`, async (c) =>
    c.json({ allowlist: await listingQueries.allowlist(operatorOf(c)) }),
  )
  app.post(`${OPS_BASE}/allowlist`, async (c) => {
    const operator = operatorOf(c)
    const { projectId, note } = TrustProjectInput.parse(await bodyOf(c))
    await listings.trustProject(operator, projectId, note ?? null)
    return c.json({ allowlist: await listingQueries.allowlist(operator) }, 201)
  })
  app.delete(`${OPS_BASE}/allowlist/:catalog/:project`, async (c) => {
    const operator = operatorOf(c)
    const { catalog, projectId } = UntrustProjectInput.parse({
      catalog: c.req.param('catalog'),
      projectId: c.req.param('project'),
    })
    await listings.untrustProject(operator, catalog, projectId)
    return c.json({ allowlist: await listingQueries.allowlist(operator) })
  })
}
