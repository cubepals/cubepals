/**
 * Local development's stand-ins (config/local.ts): on this machine, a missing or half-filled
 * outside account never stops the stack; on a deployment, nothing of it applies.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { loadConfig } from './load.ts'

const root = new URL('../../../../', import.meta.url)
/** `.env.example` as `cp .env.example .env` gives it, read the way the control plane reads `.env`. */
const example = parseEnv(readFileSync(new URL('.env.example', root), 'utf8')) as NodeJS.ProcessEnv
/** The same, deployed: on Docker, with the one region a deployment there has. */
const deployed = {
  ...example,
  WEB_CANONICAL_ORIGIN: 'https://blockly.test',
  REGIONS: 'eu:Europe',
  RUNTIME_REGION_MAP: 'eu:local',
}
const POLAR = {
  POLAR_ACCESS_TOKEN: 'polar_oat_0123456789abcdef',
  POLAR_WEBHOOK_SECRET: 'whsec_0123456789abcdef',
  POLAR_SERVER: 'sandbox',
  POLAR_PRODUCTS: 'plus:d8dd2de1-21b7-4a41-8bc3-ce909c0cfe23',
}

describe('local development', () => {
  test('.env.example, copied as it is, starts the stack with the local checkout and no sign-up cap', () => {
    const config = loadConfig(example)
    expect(config.billing).toEqual({ provider: 'local' })
    expect(config.local?.notes).toEqual(
      expect.arrayContaining([
        'Payments: the local checkout. Upgrade grants a plan, Manage billing cancels it.',
        'Sign-up: no cap on free accounts.',
        expect.stringMatching(/^Sign-in: Google is off/),
        expect.stringMatching(/^Mail: sent to 127\.0\.0\.1:1025\./),
      ]),
    )
  })

  test('Polar sandbox values alone are still the local checkout: Polar is used only when asked for', () => {
    const present = loadConfig({ ...example, ...POLAR })
    expect(present.billing).toEqual({ provider: 'local' })
    expect(present.local?.notes[0]).toMatch(/LOCAL_BILLING=polar uses Polar's values instead\.$/)
  })

  test('asked for, half of Polar is the local checkout, saying what is missing; all of it is Polar', () => {
    const asked = { ...example, LOCAL_BILLING: 'polar' }
    const { POLAR_WEBHOOK_SECRET: _, ...partial } = POLAR
    const half = loadConfig({ ...asked, ...partial })
    expect(half.billing).toEqual({ provider: 'local' })
    expect(half.local?.notes[0]).toMatch(/Polar's values are incomplete \(POLAR_WEBHOOK_SECRET: .*\)/)
    expect(loadConfig({ ...asked, ...POLAR, POLAR_WEBHOOK_SECRET: 'plain' }).local?.notes[0]).toMatch(
      /POLAR_WEBHOOK_SECRET: a Polar webhook secret starts with whsec_/,
    )
    expect(loadConfig({ ...asked, ...POLAR, POLAR_PRODUCTS: '' }).billing).toEqual({ provider: 'local' })
    expect(loadConfig(asked).billing).toEqual({ provider: 'local' })

    const whole = loadConfig({ ...asked, ...POLAR })
    expect(whole.billing).toMatchObject({ provider: 'polar', server: 'sandbox' })
    expect(whole.local?.notes[0]).toBe("Payments: Polar's sandbox server.")
  })

  test('the network address `bun run dev:lan` serves on is local too', () => {
    expect(loadConfig({ ...example, WEB_CANONICAL_ORIGIN: 'http://192.168.1.20:3000' }).local).not.toBeNull()
  })

  test('a deployment gets none of it: half of Polar is refused, and .env.example’s secrets too', () => {
    const { POLAR_WEBHOOK_SECRET: _, ...partial } = POLAR
    const secrets = {
      AUTH_SECRET: 'auth-secret-0123456789abcdef',
      REALTIME_TICKET_SECRET: 'ticket-secret-0123456789',
      EDGE_TOKEN: 'edge-token-0123456789',
      RUNTIME_SECRETS_KEY: 'runtime-secrets-0123456789',
    }
    const config = loadConfig({ ...deployed, ...secrets })
    expect(config.local).toBeNull()
    expect(config.billing).toBeNull()
    expect(() => loadConfig({ ...deployed, ...secrets, ...partial })).toThrow(/billing.webhookSecret/)
    expect(() => loadConfig(deployed)).toThrow(/AUTH_SECRET is the value .env.example gives everyone/)
  })
})
