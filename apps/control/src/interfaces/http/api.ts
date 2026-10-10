// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto'
import type { AuthMethods } from '@blockly/contracts'
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { getHTTPStatusCodeFromError } from '@trpc/server/http'
import { Hono } from 'hono'
import type { UserActor } from '../../app/actor.ts'
import type { Authenticator } from '../../app/ports/auth.ts'
import { appRouter } from '../trpc/router.ts'
import type { Services } from '../trpc/trpc.ts'
import { type AddressTrust, withClientAddress } from './client-address.ts'
import { ownPagesOnly } from './origins.ts'
import { createPublicApp } from './public.ts'

/**
 * The api role's public HTTP surface. Browsers reach it only through the web origin's /api
 * rewrite; nothing here is cached by anything in between.
 */
export function createApiApp(deps: {
  auth: Authenticator
  methods: AuthMethods
  services: Services
  /** Whose word a request's client address is taken on (client-address.ts). */
  addresses: AddressTrust
  /** Blockly's own pages: the canonical origin and the trusted ones (previews). */
  origins: readonly string[]
}): Hono<{ Variables: { requestId: string } }> {
  const app = new Hono<{ Variables: { requestId: string } }>()

  // Each request's id, as the web tier named it or a new one, said back so a report can be matched.
  app.use('*', async (c, next) => {
    const id = c.req.header('x-request-id')?.slice(0, 64) || randomUUID()
    c.set('requestId', id)
    await next()
    c.header('x-request-id', id)
  })
  // What nothing else caught: logged, reported, and a plain 500.
  app.onError((error, c) => {
    console.error('api', error)
    deps.services.insight.report(error, {
      properties: { route: c.req.path, method: c.req.method, request_id: c.get('requestId') },
    })
    return c.json({ error: 'Something went wrong on our side. Try again in a moment.' }, 500)
  })

  // Nothing about an account may be cached anywhere. Public routes set their own caching, and
  // saying it first is how they opt out.
  app.use('/api/*', async (c, next) => {
    await next()
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
  })

  app.get('/api/health', (c) => c.json({ ok: true }))

  // A public server's state, for anything outside Blockly, the faces player rows show, and the
  // textures items are drawn with.
  app.route(
    '/',
    createPublicApp({
      sharing: deps.services.sharingQueries,
      faces: deps.services.faces,
      items: deps.services.items,
    }),
  )

  // Which buttons the sign-in and sign-up pages show. Outside /api/auth, which Better Auth owns.
  app.get('/api/auth-methods', (c) => c.json(deps.methods))

  // Whether sign-up has room for another free account, so the page can say it's full up front
  // (docs/money-guards.md). Better Auth asks the same before it writes an account.
  app.get('/api/signups', async (c) => c.json({ open: await deps.services.accounts.signupsOpen() }))

  app.on(['GET', 'POST'], '/api/auth/*', (c) =>
    deps.auth.handle(withClientAddress(c.req.raw, deps.addresses)),
  )

  app.use('/api/trpc/*', ownPagesOnly(deps.origins))
  app.all('/api/trpc/*', (c) =>
    fetchRequestHandler<typeof appRouter>({
      endpoint: '/api/trpc',
      req: c.req.raw,
      router: appRouter,
      createContext: async ({ req }) => ({
        actor: await actorFrom(deps.auth, req.headers),
        services: deps.services,
      }),
      onError({ error, path, ctx }) {
        if (error.code === 'INTERNAL_SERVER_ERROR') console.error('tRPC', error.cause ?? error)
        if (getHTTPStatusCodeFromError(error) >= 500)
          deps.services.insight.report(error.cause ?? error, {
            ...(ctx?.actor ? { distinctId: ctx.actor.userId } : {}),
            properties: {
              route: `trpc:${path ?? 'unknown'}`,
              code: error.code,
              request_id: c.get('requestId'),
            },
          })
      },
    }),
  )

  return app
}

async function actorFrom(auth: Authenticator, headers: Headers): Promise<UserActor | null> {
  const userId = await auth.userOf(headers)
  return userId === null ? null : { kind: 'user', userId }
}
