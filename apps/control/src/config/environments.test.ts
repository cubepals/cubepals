import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'smol-toml'
import { serverCeilingOf } from '../infra/fly/fly-runtime.ts'
import { loadConfig } from './load.ts'

// Staging's and production's deployment configuration is what Terraform sets as Fly secrets
// (infra/terraform/environments/<name>/config.auto.tfvars.json, from its committed
// `config.auto.tfvars.example.json` where there is one) plus what each Fly app's config sets
// itself (infra/fly/*.toml). This loads it the way a deployed machine does, with stand-ins only
// for the secrets and the operator's own values, so an inconsistent environment fails here rather
// than at its first boot. It reads the committed example first, so no deployment's real values
// are needed.

const root = new URL('../../../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

interface Environment {
  settings: Record<string, string>
  secret_names: string[]
  optional_secret_names?: string[]
  fly_machine_limit: number
}

function environment(name: string): Environment {
  return JSON.parse(
    read(`infra/terraform/environments/${name}/config.auto.tfvars.example.json`),
  ) as Environment
}

/** What a Fly app's config sets: its [env], and ROLES from a process group's command. */
function flyEnv(app: string, processGroup?: string): Record<string, string> {
  const config = parse(read(`infra/fly/${app}.toml`)) as {
    env?: Record<string, string>
    processes?: Record<string, string>
  }
  const command = processGroup ? (config.processes?.[processGroup] ?? '') : ''
  const roles = command.match(/ROLES=(\S+)/)?.[1]
  return { ...config.env, ...(roles ? { ROLES: roles } : {}) }
}

/** Stand-ins shaped like the real thing, for the values the repository doesn't hold. */
function standIns(names: readonly string[]): Record<string, string> {
  const shaped: Record<string, string> = {
    DATABASE_URL: 'postgres://blockly:secret@pgbouncer.db.internal:5432/blockly',
    DATABASE_DIRECT_URL: 'postgres://blockly:secret@direct.db.internal:5432/blockly',
    SMTP_URL: 'smtps://user:secret@smtp.example.test:465',
    POLAR_WEBHOOK_SECRET: 'whsec_stand-in-for-the-webhook-secret',
  }
  return Object.fromEntries(
    names.map((name) => [name, shaped[name] ?? `stand-in-${name.toLowerCase()}-value`]),
  )
}

/** What only the operator has: their account's ids, admin emails, and the CA terms accepted. */
const OPERATOR: Record<string, Record<string, string>> = {
  staging: { POLAR_PRODUCTS: 'plus:product-id', ADMIN_EMAILS: 'ops@example.test' },
  // Production starts without billing: POLAR_PRODUCTS comes with Polar's secrets, when it charges.
  production: {
    ADMIN_EMAILS: 'ops@example.test',
    ACME_EMAIL: 'ops@example.test',
    ACME_AGREE_TOS: 'true',
  },
}

/** Values the Terraform stack computes and adds to the settings. */
const COMPUTED = {
  ARTIFACTS_RUNTIME_FACING_URL: 'https://control.example.test',
  ARCHIVE_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  // The fly-org module's default for the platform's own machines.
  FLY_PLATFORM_MACHINES: '7',
  // TF_VAR_cloudflare_zone_id, where the realtime role's DNS-01 challenges go.
  CLOUDFLARE_ZONE_ID: 'zone-id',
}
/** The stack passes the organization's machine limit from the environment's variables. */
const limitOf = (env: Environment) => ({ FLY_MACHINE_LIMIT: String(env.fly_machine_limit) })

describe.each(['staging', 'production'])('the %s environment', (name) => {
  const env = environment(name)
  const { settings, secret_names } = env
  const shared = { ...settings, ...COMPUTED, ...limitOf(env), ...OPERATOR[name], ...standIns(secret_names) }

  test('every role loads its configuration as its Fly machine will', () => {
    for (const [app, group] of [
      ['control', 'api'],
      ['control', 'worker'],
      ['realtime', undefined],
    ] as const) {
      const config = loadConfig({ ...shared, ...flyEnv(app, group) })
      expect(config.deploymentId).toBe(settings.DEPLOYMENT_ID ?? '')
      expect(config.runtimes.map((r) => r.provider)).toEqual(['fly'])
    }
    expect(loadConfig({ ...shared, ...flyEnv('control', 'api') }).roles).toEqual(['api'])
    // The org's machines hold maxServers down: two a server, beside the platform's seven, as the
    // Fly runtime counts them from what this environment configures (docs/money-guards.md).
    const [runtime] = loadConfig({ ...shared, ...flyEnv('control', 'api') }).runtimes
    if (runtime?.provider !== 'fly') throw new Error('not fly')
    expect([runtime.machineLimit, runtime.platformMachines]).toEqual([env.fly_machine_limit, 7])
    expect(serverCeilingOf(runtime.machineLimit, runtime.platformMachines)).toBeGreaterThan(0)
    expect(loadConfig({ ...shared, ...flyEnv('realtime') }).roles).toEqual(['realtime'])
    // The live-update listener and the migrations skip Managed Postgres's pooler, which closes a
    // client idle for ten minutes; everything else goes through it.
    expect(secret_names).toContain('DATABASE_DIRECT_URL')
    expect(loadConfig({ ...shared, ...flyEnv('realtime') }).database).toEqual({
      url: 'postgres://blockly:secret@pgbouncer.db.internal:5432/blockly',
      directUrl: 'postgres://blockly:secret@direct.db.internal:5432/blockly',
      poolMax: 10,
    })
  })

  test('a secret left out is a failed start, not a silent default', () => {
    for (const secret of ['AUTH_SECRET', 'RUNTIME_SECRETS_KEY', 'EDGE_TOKEN', 'REALTIME_TICKET_SECRET']) {
      expect(secret_names).toContain(secret)
      expect(() => loadConfig({ ...shared, ...flyEnv('control', 'api'), [secret]: undefined })).toThrow()
    }
  })

  test('nothing secret is committed as a setting', () => {
    const secretish = /SECRET|TOKEN|PASSWORD|DATABASE_(DIRECT_)?URL|SMTP_URL|KEY_ID/
    // PostHog's project token is public by design: every page ships it to the browser.
    const published = new Set(['POSTHOG_TOKEN'])
    expect(Object.keys(settings).filter((key) => secretish.test(key) && !published.has(key))).toEqual([])
  })
})

describe('the Fly apps', () => {
  test('realtime restarts after a clean exit, which is how it rotates its certificate (§13)', () => {
    const config = parse(read('infra/fly/realtime.toml')) as { restart?: { policy?: string }[] }
    expect(config.restart).toEqual([{ policy: 'always' }])
  })
})

describe('where the environments differ', () => {
  const { settings } = environment('production')

  test('production serves realtime over an ACME certificate for the host browsers dial, and trusts no other origin', () => {
    const config = loadConfig({
      ...settings,
      ...COMPUTED,
      ...OPERATOR.production,
      ...standIns(environment('production').secret_names),
      ...flyEnv('realtime'),
    })
    expect(config.realtime.tls).toMatchObject({ mode: 'acme', hostname: 'rt.cubepals.com', agreeTos: true })
    expect(config.web.trustedOrigins).toEqual([])
    expect(config.auth.oauthProxy).toBeNull()
  })

  test('production starts with billing off, and Polar’s values alone turn it on', () => {
    const production = environment('production')
    const base = {
      ...production.settings,
      ...COMPUTED,
      ...OPERATOR.production,
      ...standIns(production.secret_names),
      ...flyEnv('control', 'api'),
    }
    expect(production.secret_names.filter((name) => name.startsWith('POLAR_'))).toEqual([])
    expect(loadConfig(base).billing).toBeNull()

    const polar = ['POLAR_ACCESS_TOKEN', 'POLAR_WEBHOOK_SECRET']
    expect(production.optional_secret_names).toEqual(expect.arrayContaining(polar))
    const billing = loadConfig({ ...base, ...standIns(polar), POLAR_PRODUCTS: 'plus:product-id' }).billing
    expect(billing).toMatchObject({ provider: 'polar', server: 'production' })
    // Nothing of local development's stand-ins: half of Polar's values is refused, not stood in for,
    // and sign-up keeps its cap (config.local is what lifts it).
    expect(loadConfig(base).local).toBeNull()
    expect(() =>
      loadConfig({ ...base, ...standIns(['POLAR_ACCESS_TOKEN']), POLAR_PRODUCTS: 'plus:product-id' }),
    ).toThrow(/billing.webhookSecret/)
  })

  test('staging trusts only its own previews, and proxies their Google sign-ins', () => {
    const staging = environment('staging')
    const config = loadConfig({
      ...staging.settings,
      ...COMPUTED,
      ...OPERATOR.staging,
      ...standIns(staging.secret_names),
      ...flyEnv('control', 'api'),
    })
    expect(config.web.trustedOrigins).toEqual([staging.settings.WEB_TRUSTED_ORIGINS ?? ''])
    expect(config.auth.oauthProxy).not.toBeNull()
    expect(config.billing).toMatchObject({ provider: 'polar', server: 'sandbox' })
    expect(config.local).toBeNull()
  })
})
