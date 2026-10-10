import { timingSafeEqual } from 'node:crypto'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { OperatorActor } from '../../app/actor.ts'
import { AppError, NotFound } from '../../app/errors.ts'

/**
 * What every operators' API on the internal listener shares (`runtimes.ts`, `ops.ts`): the
 * OPERATOR_TOKEN bearer, compared in constant time; errors as the JSON the operator CLIs read
 * (`scripts/lib/operator-cli.ts`); and the operator the `x-operator` header names, who the audit
 * log says acted. What each API offers is its own.
 */
export function gate(app: Hono, base: string, token: string): void {
  const expected = Buffer.from(`Bearer ${token}`)
  app.use(`${base}/*`, async (c, next) => {
    const given = Buffer.from(c.req.header('authorization') ?? '')
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return c.json({ error: 'unauthorized' }, 401)
    await next()
  })
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ error: { code: error.code, message: error.message } }, 400)
    if (error instanceof NotFound)
      return c.json({ error: { code: 'not_found', message: error.message } }, 404)
    if (error instanceof z.ZodError)
      return c.json({ error: { code: 'invalid', message: z.prettifyError(error) } }, 400)
    return c.json({ error: { code: 'failed', message: (error as Error).message } }, 500)
  })
}

/** The operator a request names in `x-operator`; a request that names nobody is `unnamed`'s. */
export const operatorOf = (c: { req: { header: (name: string) => string | undefined } }): OperatorActor => ({
  kind: 'operator',
  name: (c.req.header('x-operator') ?? 'unnamed').slice(0, 64),
})
