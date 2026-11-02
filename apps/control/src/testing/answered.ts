// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** UI tests answer through the real router and its serializer, instead of duplicating HTTP envelopes. */
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { appRouter } from '../interfaces/trpc/router.ts'
import type { Services } from '../interfaces/trpc/trpc.ts'

export function answered(answer: (service: string, method: string, args: unknown[]) => unknown) {
  const branch = (service: string, path: string[]): unknown =>
    new Proxy(answer, {
      get: (_, key: string) => branch(service, [...path, key]),
      apply: (_, _receiver, args) => answer(service, path.join('.'), args),
    })
  const services = new Proxy({}, { get: (_, service: string) => branch(service, []) }) as Services
  return (url: string | URL | Request, init?: RequestInit) =>
    fetchRequestHandler({
      endpoint: '/api/trpc',
      req: new Request(String(url), init),
      router: appRouter,
      createContext: async () => ({
        actor: { kind: 'user' as const, userId: crypto.randomUUID() },
        services,
      }),
    })
}
