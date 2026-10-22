// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What production.ts checks and hands to Terraform, on stand-in values only: none of them is real.
 * The environment's decided values come from its committed example, not an operator's own file.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_ABUSE_LIMITS,
  DEFAULT_CAPACITY_TUNING,
  DEFAULT_ECONOMICS_TUNING,
  DEFAULT_FREE_LINK_TUNING,
} from '../apps/control/src/domain/account/tuning.ts'
import {
  backendConfig,
  DUMPS_BUCKET,
  dumpSecrets,
  ENVIRONMENT_EXAMPLE,
  environment,
  parseValues,
  problemsOf,
  terraformEnv,
  VALUES,
  valuesFile,
} from './production-values.ts'

const tfvars = JSON.parse(readFileSync(join(import.meta.dir, '..', ENVIRONMENT_EXAMPLE), 'utf8')) as {
  secret_names: string[]
  optional_secret_names: string[]
}
const example = environment(ENVIRONMENT_EXAMPLE)

/** Every value production needs, shaped like the real ones; none of it is real. */
const complete: Record<string, string> = {
  ...parseValues(valuesFile({})),
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  CLOUDFLARE_ZONE_ID: 'fedcba9876543210fedcba9876543210',
  CLOUDFLARE_API_TOKEN: 'stand-in-cloudflare-api-token',
  CLOUDFLARE_WORKERS_API_TOKEN: 'stand-in-cloudflare-workers-token',
  TF_STATE_ACCESS_KEY_ID: 'stand-in-state-key-id',
  TF_STATE_SECRET_ACCESS_KEY: 'stand-in-state-secret',
  FLY_API_TOKEN: 'FlyV1 fm2_stand-in-org-token',
  DATABASE_URL: 'postgres://blockly:secret@pgbouncer.cluster.flympg.net/blockly',
  DATABASE_DIRECT_URL: 'postgres://blockly:secret@direct.cluster.flympg.net/blockly',
  AUTH_GOOGLE_CLIENT_ID: '1234-stand-in.apps.googleusercontent.com',
  AUTH_GOOGLE_CLIENT_SECRET: 'stand-in-google-client-secret',
  SMTP_URL: 'smtps://user:secret@smtp.example.test:465',
  CLOUDFLARE_DNS_API_TOKEN: 'stand-in-cloudflare-dns-token',
  ARCHIVE_S3_ACCESS_KEY_ID: 'stand-in-archive-key-id',
  ARCHIVE_S3_SECRET_ACCESS_KEY: 'stand-in-archive-secret',
  DUMP_S3_ACCESS_KEY_ID: 'stand-in-dumps-key-id',
  DUMP_S3_SECRET_ACCESS_KEY: 'stand-in-dumps-secret',
  ADMIN_EMAILS: 'owner@example.test',
  ACME_EMAIL: 'owner@example.test',
  ACME_AGREE_TOS: 'true',
  FREE_LINK_TUNING: JSON.stringify(DEFAULT_FREE_LINK_TUNING),
  ABUSE_LIMITS: JSON.stringify(DEFAULT_ABUSE_LIMITS),
  CAPACITY_TUNING: JSON.stringify(DEFAULT_CAPACITY_TUNING),
}
const without = (...names: string[]) =>
  Object.fromEntries(Object.entries(complete).filter(([name]) => !names.includes(name)))
const billing = {
  POLAR_ACCESS_TOKEN: 'polar_oat_stand-in-token',
  POLAR_WEBHOOK_SECRET: 'whsec_stand-in-webhook-secret',
  POLAR_PRODUCTS: 'plus:product-id',
}

describe('the values', () => {
  test('name exactly the secrets the production environment takes', () => {
    const secrets = VALUES.filter((v) => v.goes.includes('secret'))
    expect(secrets.filter((v) => !v.optional).map((v) => v.name)).toEqual(
      expect.arrayContaining(tfvars.secret_names),
    )
    expect(secrets.map((v) => v.name).sort()).toEqual(
      [...tfvars.secret_names, ...tfvars.optional_secret_names].sort(),
    )
  })

  test('say where each comes from, unless this script makes it', () => {
    for (const value of VALUES) expect(Boolean(value.where) !== Boolean(value.generate)).toBe(true)
  })
})

describe('the values file', () => {
  test('init makes the random ones, leaves the rest to fill in, and keeps what is already there', () => {
    const made = parseValues(valuesFile({}))
    expect(Object.keys(made).sort()).toEqual(
      [
        'AUTH_SECRET',
        'EDGE_TOKEN',
        'OPERATOR_TOKEN',
        'REALTIME_TICKET_SECRET',
        'RUNTIME_SECRETS_KEY',
        'WEB_PROXY_SECRET',
      ].sort(),
    )
    expect(made.RUNTIME_SECRETS_KEY).toMatch(/^1:.{40,}$/)
    expect(parseValues(valuesFile({})).AUTH_SECRET).not.toBe(made.AUTH_SECRET)

    const kept = { ADMIN_EMAILS: 'owner@example.test', ADMIN_ALERT_EMAILS: 'ops@example.test' }
    const again = parseValues(valuesFile({ ...made, ...kept }))
    expect(again).toEqual({ ...made, ...kept })
  })

  test('reads NAME=value lines, past comments, quotes and an = inside a value', () => {
    expect(parseValues('# a comment\nA="quoted"\nB=x=y\n\nC=\n  D = spaced ')).toEqual({
      A: 'quoted',
      B: 'x=y',
      D: 'spaced',
    })
  })
})

describe('the check', () => {
  test('a fresh file lists every value to fill in, and no optional one', () => {
    const { missing, bucketFirst } = problemsOf(parseValues(valuesFile({})))
    expect(missing.map((v) => v.name)).toContain('DATABASE_URL')
    expect(missing.some((v) => v.optional)).toBe(false)
    expect(bucketFirst).toBe(false)
  })

  test('every value, in shape, starts the control plane: nothing to fix, billing off', () => {
    expect(problemsOf(complete, example)).toEqual({ missing: [], wrong: [], bucketFirst: false })
  })

  test("only the buckets' tokens missing lets the first apply make the buckets", () => {
    const tokens = [
      'ARCHIVE_S3_ACCESS_KEY_ID',
      'ARCHIVE_S3_SECRET_ACCESS_KEY',
      'DUMP_S3_ACCESS_KEY_ID',
      'DUMP_S3_SECRET_ACCESS_KEY',
    ]
    const { missing, wrong, bucketFirst } = problemsOf(without(...tokens), example)
    expect(missing.map((v) => v.name)).toEqual(tokens)
    expect(wrong).toEqual([])
    expect(bucketFirst).toBe(true)
    expect(problemsOf(without('DUMP_S3_SECRET_ACCESS_KEY'), example).bucketFirst).toBe(true)
  })

  test('billing comes whole or not at all', () => {
    expect(problemsOf({ ...complete, ...billing }, example).wrong).toEqual([])
    expect(
      problemsOf({ ...complete, POLAR_ACCESS_TOKEN: billing.POLAR_ACCESS_TOKEN }, example).wrong,
    ).toEqual([
      'POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET, POLAR_PRODUCTS come together, or not at all (billing).',
    ])
  })

  test('a value in the wrong shape, or under a name production does not use, is named', () => {
    const { wrong } = problemsOf({
      ...complete,
      ACME_AGREE_TOS: 'yes',
      SMTP_URL: 'smtp.example.test',
      POLAR_WEBHOOK_SCRET: 'x',
    })
    expect(wrong).toEqual([
      'SMTP_URL is an smtp:// or smtps:// URL.',
      'ACME_AGREE_TOS is true, once you accept the terms.',
      "POLAR_WEBHOOK_SCRET isn't a value production uses. Check its name.",
    ])
  })

  test('what the control plane refuses is said before anything is made, and no value is printed', () => {
    const { wrong } = problemsOf({ ...complete, ADMIN_EMAILS: 'not-an-email', AUTH_SECRET: 'short' }, example)
    expect(wrong.join('\n')).toContain("role wouldn't start")
    expect(wrong.join('\n')).toContain('auth.secret')
    expect(wrong.join('\n')).not.toContain('not-an-email')
    expect(wrong.join('\n')).not.toContain(complete.DATABASE_URL)
  })
})

describe('what Terraform gets', () => {
  test('secrets, a version for each, the operator settings and the providers’ tokens', () => {
    const env = terraformEnv(complete)
    const secrets = JSON.parse(env.TF_VAR_secrets ?? '{}') as Record<string, string>
    expect(Object.keys(secrets).sort()).toEqual([...tfvars.secret_names].sort())
    expect(secrets.FLY_API_TOKEN).toBe(complete.FLY_API_TOKEN)
    expect(JSON.parse(env.TF_VAR_operator_settings ?? '{}')).toEqual({
      ADMIN_EMAILS: 'owner@example.test',
      ACME_EMAIL: 'owner@example.test',
      ACME_AGREE_TOS: 'true',
    })
    expect(env.TF_VAR_cloudflare_zone_id).toBe(complete.CLOUDFLARE_ZONE_ID)
    expect(env.AWS_ACCESS_KEY_ID).toBe(complete.TF_STATE_ACCESS_KEY_ID)
  })

  test('the admin inbox reaches the control plane as an operator setting, beside ADMIN_EMAILS', () => {
    const env = terraformEnv({ ...complete, ADMIN_ALERT_EMAILS: 'ops@example.test' })
    expect(JSON.parse(env.TF_VAR_operator_settings ?? '{}')).toMatchObject({
      ADMIN_EMAILS: 'owner@example.test',
      ADMIN_ALERT_EMAILS: 'ops@example.test',
    })
    expect(problemsOf({ ...complete, ADMIN_ALERT_EMAILS: 'ops@example.test' }, example).wrong).toEqual([])
    expect(problemsOf({ ...complete, ADMIN_ALERT_EMAILS: 'not-an-email' }, example).wrong).not.toEqual([])
  })

  test("the website's own values, its deploy token included, never reach Terraform", () => {
    const env = terraformEnv({
      ...complete,
      POSTHOG_PERSONAL_API_KEY: 'phx_example',
      POSTHOG_PROJECT_ID: '1234',
    })
    const all = Object.values(env).join('\n')
    expect(all).not.toContain('phx_example')
    expect(all).not.toContain(complete.CLOUDFLARE_WORKERS_API_TOKEN)
  })

  test('a version changes with its value and holds none of it', () => {
    const versions = (values: Record<string, string>) =>
      JSON.parse(terraformEnv(values).TF_VAR_secret_versions ?? '{}') as Record<string, string>
    const before = versions(complete)
    const after = versions({ ...complete, SMTP_URL: 'smtps://user:other@smtp.example.test:465' })
    expect(Object.keys(before).sort()).toEqual([...tfvars.secret_names].sort())
    expect(before.SMTP_URL).toMatch(/^[0-9a-f]{12}$/)
    expect(after.SMTP_URL).not.toBe(before.SMTP_URL)
    expect(after.AUTH_SECRET).toBe(before.AUTH_SECRET)
  })

  test("billing's values, once given, are all it takes to turn it on", () => {
    const env = terraformEnv({ ...complete, ...billing })
    expect(Object.keys(JSON.parse(env.TF_VAR_secrets ?? '{}'))).toEqual(
      expect.arrayContaining(['POLAR_ACCESS_TOKEN', 'POLAR_WEBHOOK_SECRET']),
    )
    expect(JSON.parse(env.TF_VAR_operator_settings ?? '{}').POLAR_PRODUCTS).toBe('plus:product-id')
  })

  test('the dumps bucket is named once, and its token never reaches Terraform or the apps', () => {
    const env = terraformEnv(complete)
    expect(env.TF_VAR_database_dumps_bucket).toBe(DUMPS_BUCKET)
    expect(Object.values(env).join('\n')).not.toContain('stand-in-dumps-secret')
  })

  test("the Database dump workflow's secrets: the direct URL, the account's endpoint, the bucket and its token", () => {
    expect(dumpSecrets(complete)).toEqual({
      DATABASE_URL: 'postgres://blockly:secret@direct.cluster.flympg.net/blockly',
      DUMP_S3_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      DUMP_S3_BUCKET: DUMPS_BUCKET,
      DUMP_S3_ACCESS_KEY_ID: 'stand-in-dumps-key-id',
      DUMP_S3_SECRET_ACCESS_KEY: 'stand-in-dumps-secret',
    })
  })

  test('the dump reads the database root from the checkout, where the control image has it under /app', () => {
    const verified = `${complete.DATABASE_DIRECT_URL}?sslmode=verify-full&sslrootcert=/app/packages/db/certs/root.crt`
    const url = new URL(dumpSecrets({ ...complete, DATABASE_DIRECT_URL: verified }).DATABASE_URL ?? '')
    expect(url.searchParams.get('sslrootcert')).toBe('packages/db/certs/root.crt')
    expect(url.searchParams.get('sslmode')).toBe('verify-full')
  })

  test("the state lives in the operator's R2 bucket, under the account's endpoint", () => {
    expect(backendConfig('0123456789abcdef0123456789abcdef')).toContain(
      'endpoints                   = { s3 = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com" }',
    )
  })
})

describe('the optional tuning and official files', () => {
  test('the economics tuning, official files and Stop cheaters are optional secrets, each on its own', () => {
    const economics = JSON.stringify(DEFAULT_ECONOMICS_TUNING)
    const files = JSON.stringify({ '*': { 'server.properties': 'motd=Cubepals\n' } })
    const stopCheaters = JSON.stringify({
      punishments: 'Punishments: {}\n',
      ban: { reason: 'impossible', removals: 1, withinMinutes: 1, minutes: 1 },
    })
    for (const given of [
      { ECONOMICS_TUNING: economics },
      { OFFICIAL_SERVER_FILES: files },
      { STOP_CHEATERS: stopCheaters },
    ]) {
      expect(problemsOf({ ...complete, ...given }, example).wrong).toEqual([])
      expect(JSON.parse(terraformEnv({ ...complete, ...given }).TF_VAR_secrets ?? '{}')).toMatchObject(given)
    }
    expect(
      problemsOf({ ...complete, ECONOMICS_TUNING: '{"paymentFee":1}' }, example).wrong.join('\n'),
    ).toContain('economicsTuning')
    expect(problemsOf({ ...complete, OFFICIAL_SERVER_FILES: '{"*":' }, example).wrong).toEqual([
      'OFFICIAL_SERVER_FILES is one line of JSON.',
    ])
  })

  test('a multi-line file for official servers survives the values file and reaches Terraform as one string', () => {
    const yaml =
      'messages:\n  join: "Welcome, it\'s \\"{player}\\""\n  path: C:\\data\n  list:\n    - a # b\n'
    const files = { '*': { 'plugins/Example/config.yml': yaml } }
    const written = valuesFile({ ...complete, OFFICIAL_SERVER_FILES: JSON.stringify(files) })
    const values = parseValues(written)
    expect(JSON.parse(values.OFFICIAL_SERVER_FILES ?? '')).toEqual(files)
    const secrets = JSON.parse(terraformEnv(values).TF_VAR_secrets ?? '{}') as Record<string, string>
    expect(JSON.parse(secrets.OFFICIAL_SERVER_FILES ?? '')).toEqual(files)
    expect(problemsOf(values, example).wrong).toEqual([])
  })

  test("Terraform's template markers in a value are escaped, so Terraform reads them as written", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a plugin's placeholder, which Terraform would read as a template.
    const content = 'join: ${player} %{x} $${kept} \\b\b\f'
    const secrets = terraformEnv({ ...complete, OFFICIAL_SERVER_FILES: content }).TF_VAR_secrets ?? ''
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a plugin's placeholder, which Terraform would read as a template.
    expect(secrets).toContain('"join: $${player} %%{x} $$${kept} \\\\b\\u0008\\u000c"')
  })

  test.skipIf(!Bun.which('terraform'))('Terraform itself reads every secret back as it was written', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a plugin's placeholder, which Terraform would read as a template.
    const content = 'a: ${player}\n%{ if x }\nb: $${kept} %%{also} \\path\b\f\u0001 ’ "quoted" end$'
    const dir = mkdtempSync(join(tmpdir(), 'blockly-tfvar-'))
    writeFileSync(
      join(dir, 'main.tf'),
      'variable "secrets" {\n  type      = map(string)\n  sensitive = true\n}\n',
    )
    const read = spawnSync('terraform', ['console'], {
      cwd: dir,
      input: 'jsonencode(nonsensitive(var.secrets))\n',
      encoding: 'utf8',
      env: {
        ...process.env,
        TF_VAR_secrets: terraformEnv({ ...complete, OFFICIAL_SERVER_FILES: content }).TF_VAR_secrets,
      },
    })
    rmSync(dir, { recursive: true, force: true })
    expect(read.stderr).toBe('')
    const secrets = JSON.parse(JSON.parse(read.stdout)) as Record<string, string>
    expect(secrets.OFFICIAL_SERVER_FILES).toBe(content)
    expect(secrets.FLY_API_TOKEN).toBe(complete.FLY_API_TOKEN)
  })
})

describe('join records', () => {
  test('left out, nothing reaches the control plane: no reporter and no signals', () => {
    expect(problemsOf(complete, example)).toEqual({ missing: [], wrong: [], bucketFirst: false })
    const env = terraformEnv(complete)
    expect(JSON.parse(env.TF_VAR_secrets ?? '{}')).not.toHaveProperty('SIGNALS')
    expect(JSON.parse(env.TF_VAR_operator_settings ?? '{}')).not.toHaveProperty('JOIN_REPORTER')
  })

  test('given, the reporter is an operator setting and the signals a secret', () => {
    // `{}` turns no kind of signal on: the shape only, no limits.
    const given = { JOIN_REPORTER: 'official', SIGNALS: '{}' }
    expect(problemsOf({ ...complete, ...given }, example).wrong).toEqual([])
    const env = terraformEnv({ ...complete, ...given })
    expect(JSON.parse(env.TF_VAR_operator_settings ?? '{}')).toMatchObject({ JOIN_REPORTER: 'official' })
    expect(JSON.parse(env.TF_VAR_secrets ?? '{}')).toMatchObject({ SIGNALS: '{}' })
    expect(JSON.parse(env.TF_VAR_secrets ?? '{}')).not.toHaveProperty('JOIN_REPORTER')
  })

  test('a reporter setting or signals the control plane would not read are named before anything is made', () => {
    expect(problemsOf({ ...complete, JOIN_REPORTER: 'some' }, example).wrong.join('\n')).toContain('reporter')
    expect(problemsOf({ ...complete, SIGNALS: '{"slowJoin":' }, example).wrong).toEqual([
      'SIGNALS is one line of JSON.',
    ])
    expect(problemsOf({ ...complete, SIGNALS: '{"slowJoin":"fast"}' }, example).wrong).toEqual([
      'SIGNALS is not in the shape the signals job reads.',
    ])
  })
})

describe('the Bedrock key', () => {
  const key = Buffer.alloc(16, 3).toString('base64')

  test('left out, apply runs and writes no secret: no server is given Floodgate', () => {
    expect(complete).not.toHaveProperty('FLOODGATE_KEY')
    expect(problemsOf(complete, example)).toEqual({ missing: [], wrong: [], bucketFirst: false })
    expect(JSON.parse(terraformEnv(complete).TF_VAR_secrets ?? '{}')).not.toHaveProperty('FLOODGATE_KEY')
  })

  test('given, it is a secret; 16 bytes as base64 is the only shape the control plane reads', () => {
    expect(problemsOf({ ...complete, FLOODGATE_KEY: key }, example).wrong).toEqual([])
    expect(
      JSON.parse(terraformEnv({ ...complete, FLOODGATE_KEY: key }).TF_VAR_secrets ?? '{}'),
    ).toMatchObject({
      FLOODGATE_KEY: key,
    })
    expect(problemsOf({ ...complete, FLOODGATE_KEY: 'not-a-key' }, example).wrong).toEqual([
      'FLOODGATE_KEY is not 16 bytes as base64.',
    ])
  })
})

describe('the notices’ sender', () => {
  test('is one of the environment’s settings, not a value kept in production.env', () => {
    expect(example.settings.MAIL_NOTICE_FROM).toBe('Cubepals <noreply@beacon.cubepals.com>')
    expect(VALUES.map((v) => v.name)).not.toContain('MAIL_NOTICE_FROM')
    expect(problemsOf(complete, example).wrong).toEqual([])
  })
})
