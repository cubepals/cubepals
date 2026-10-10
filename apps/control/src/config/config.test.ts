// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import { configFromEnv, loadConfig } from './load.ts'
import { ConfiguredPlayAddressing } from './play-addressing.ts'

const env = {
  DEPLOYMENT_ID: 'local',
  DATABASE_URL: 'postgres://blockly:blockly@127.0.0.1:5432/blockly',
  WEB_CANONICAL_ORIGIN: 'http://localhost:3000',
  REALTIME_PUBLIC_URL: 'https://127.0.0.1:7443/',
  REALTIME_FALLBACK_URL: 'ws://127.0.0.1:7444/transport-io',
  REALTIME_TICKET_SECRET: 'ticket-secret-0123456789',
  PLAY_DOMAIN: 'play.localhost',
  REGIONS: 'local:This computer',
  RUNTIME_REGION_MAP: 'local:local',
  AUTH_SECRET: 'auth-secret-0123456789abcdef',
  SMTP_URL: 'smtp://127.0.0.1:1025',
  MAIL_FROM: 'Cubepals <hello@localhost>',
  EDGE_TOKEN: 'edge-token-0123456789',
  RUNTIME_SECRETS_KEY: 'runtime-secrets-0123456789',
  ARTIFACTS_RUNTIME_FACING_URL: 'http://host.docker.internal:4000',
}

/** The same, deployed: locally, a Polar setup that falls short is the local checkout (local.test.ts). */
const deployed = { ...env, WEB_CANONICAL_ORIGIN: 'https://blockly.test' }

describe('configuration', () => {
  test('a local environment parses with defaults', () => {
    const config = loadConfig(env)
    expect(config.play).toEqual({ domain: 'play.localhost', aliases: [], port: 25565 })
    expect(config.archive).toBeNull()
    expect(config.runtimes.map((r) => r.provider)).toEqual(['docker'])
    expect(config.defaultRuntime).toBe('docker')
    expect(config.roles).toEqual(['api', 'worker', 'realtime'])
    // MODRINTH_USER_AGENT was read and never used; CATALOG_USER_AGENT names Blockly to Modrinth.
    expect(config).not.toHaveProperty('modrinth')
    expect(config.catalog.userAgent).toBe('blockly-control/local (+https://github.com/cubepals/cubepals)')
  })

  test('a Boat deployment reads its key and lets Blockly alone stop a server unless told otherwise', () => {
    const boat = { ...env, RUNTIME_PROVIDER: 'boat', BOAT_API_TOKEN: 'boat_p_0123456789abcdef' }
    expect(loadConfig(boat).runtimes[0]).toEqual({
      provider: 'boat',
      apiToken: 'boat_p_0123456789abcdef',
      apiUrl: 'https://boat.dev/api/v1',
      regionMap: { local: 'local' },
      runTtlSeconds: null,
      startReserve: 0.1,
    })
    expect(loadConfig({ ...boat, BOAT_RUN_TTL_SECONDS: '7200' }).runtimes[0]).toMatchObject({
      runTtlSeconds: 7200,
    })
    expect(() => loadConfig({ ...boat, BOAT_API_TOKEN: '' })).toThrow()
  })

  test('Fly, Boat and the fleet run in one deployment, each with its own region map', () => {
    const all = {
      ...env,
      RUNTIME_PROVIDER: 'fly',
      RUNTIME_PROVIDERS: 'fly,boat,fleet',
      REGIONS: 'eu:Europe,us:North America',
      RUNTIME_REGION_MAP: 'eu:fra,us:iad',
      BOAT_REGION_MAP: 'eu:eu',
      FLEET_REGION_MAP: 'eu:eu-rbx',
      FLY_ORG: 'blockly',
      FLY_API_TOKEN: 'FlyV1 fm2_0123456789abcdef',
      BOAT_API_TOKEN: 'boat_p_0123456789abcdef',
      FLEET_CA_CERT: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
      FLEET_CA_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
      FLEET_ENDPOINT_HOSTS: '10.0.0.2',
      OPERATOR_TOKEN: 'operator-token-0123456789abcdef',
      ARCHIVE_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      ARCHIVE_S3_BUCKET: 'blockly',
      ARCHIVE_S3_ACCESS_KEY_ID: 'key',
      ARCHIVE_S3_SECRET_ACCESS_KEY: 'secret',
    }
    const config = loadConfig(all)
    expect(config.defaultRuntime).toBe('fly')
    expect(config.runtimes.map((r) => [r.provider, r.regionMap])).toEqual([
      ['fly', { eu: 'fra', us: 'iad' }],
      ['boat', { eu: 'eu' }],
      ['fleet', { eu: 'eu-rbx' }],
    ])
    // Nodes reach the fleet's endpoint over Fly's private network, which is IPv6: it listens on both.
    expect(config.runtimes[2]).toMatchObject({ provider: 'fleet', nodeListen: '[::]:8443' })
    // The default places every region; the others may place some. A runtime twice, or a default
    // the list doesn't run, is refused by name.
    expect(() => loadConfig({ ...all, RUNTIME_REGION_MAP: 'eu:fra' })).toThrow(
      /Region "us" has no placement on the default runtime, fly/,
    )
    expect(() => loadConfig({ ...all, RUNTIME_PROVIDERS: 'fly,boat,boat' })).toThrow(/names a runtime twice/)
    expect(() => loadConfig({ ...all, RUNTIME_PROVIDER: 'docker' })).toThrow(/RUNTIME_PROVIDERS doesn't list/)
    expect(() => loadConfig({ ...all, OPERATOR_TOKEN: '' })).toThrow(/OPERATOR_TOKEN/)
    // RUNTIME_REGION_MAP is the default's alone: borrowed, it would have Boat claim every region
    // Fly serves. A runtime beside the default without its own map is refused, naming what to set.
    expect(() => loadConfig({ ...all, BOAT_REGION_MAP: undefined })).toThrow(
      /boat runs beside the default runtime, fly, and places only the regions its own map names\. Set BOAT_REGION_MAP\./,
    )
    expect(() => loadConfig({ ...all, FLEET_REGION_MAP: '' })).toThrow(/Set FLEET_REGION_MAP\./)
    // The default's own map may stand in for RUNTIME_REGION_MAP.
    expect(
      loadConfig({ ...all, RUNTIME_REGION_MAP: undefined, FLY_REGION_MAP: 'eu:fra,us:iad' }).runtimes[0]
        ?.regionMap,
    ).toEqual({ eu: 'fra', us: 'iad' })
  })

  test('the runtime key carries its version, and a rotation lists the earlier keys it still accepts', () => {
    expect(loadConfig(env).runtimeSecrets).toEqual({
      current: { version: 1, key: 'runtime-secrets-0123456789' },
      previous: [],
    })
    const rotating = loadConfig({
      ...env,
      RUNTIME_SECRETS_KEY: '3:runtime-secrets-three-0123456789',
      RUNTIME_SECRETS_PREVIOUS_KEYS: '2:runtime-secrets-two-0123456789, runtime-secrets-0123456789',
    })
    expect(rotating.runtimeSecrets).toEqual({
      current: { version: 3, key: 'runtime-secrets-three-0123456789' },
      previous: [
        { version: 2, key: 'runtime-secrets-two-0123456789' },
        { version: 1, key: 'runtime-secrets-0123456789' },
      ],
    })
    // An earlier key can't be as new as the current one, nor listed twice.
    expect(() =>
      loadConfig({ ...env, RUNTIME_SECRETS_PREVIOUS_KEYS: '1:runtime-secrets-other-0123456789' }),
    ).toThrow(/older than/)
    expect(() =>
      loadConfig({
        ...env,
        RUNTIME_SECRETS_KEY: '3:runtime-secrets-three-0123456789',
        RUNTIME_SECRETS_PREVIOUS_KEYS: '2:runtime-secrets-two-0123456789,2:runtime-secrets-too-0123456789',
      }),
    ).toThrow(/each version once/)
  })

  // `bun run dev:lan` serves the dev stack to a phone on the same Wi-Fi, at the machine's own
  // network address; a deployment anyone else uses is never served over plain http.
  test('plain http is for this machine and its own network, never a public address', () => {
    const lan = (origin: string) =>
      loadConfig({
        ...env,
        WEB_CANONICAL_ORIGIN: origin,
        WEB_TRUSTED_ORIGINS: 'http://localhost:3000',
        PLAY_DOMAIN: '192.168.1.20.nip.io',
        PLAY_DOMAIN_ALIASES: 'play.localhost',
      })
    for (const origin of ['http://192.168.1.20:3000', 'http://10.0.0.7:3000', 'http://172.20.1.2:3000'])
      expect(lan(origin).web.canonicalOrigin).toBe(origin)
    for (const origin of ['http://172.32.0.1:3000', 'http://8.8.8.8:3000', 'http://blockly.example'])
      expect(() => lan(origin)).toThrow('must use https outside local development')
  })

  test('platform hosts under a play domain are refused', () => {
    expect(() =>
      loadConfig({ ...env, PLAY_DOMAIN: 'localhost', WEB_CANONICAL_ORIGIN: 'http://app.localhost:3000' }),
    ).toThrow(/play domain/)
  })

  test('a localhost realtime URL cannot reach an IPv4-only listener', () => {
    expect(() => loadConfig({ ...env, REALTIME_PUBLIC_URL: 'https://localhost:7443/' })).toThrow(/IPv6/)
    expect(() =>
      loadConfig({ ...env, REALTIME_PUBLIC_URL: 'https://localhost:7443/', REALTIME_LISTEN: '[::1]:7443' }),
    ).not.toThrow()
  })

  test('an OAuth provider is on with both halves of its client, off with neither', () => {
    expect(loadConfig(env).auth.google).toBeNull()
    expect(
      loadConfig({ ...env, AUTH_GOOGLE_CLIENT_ID: 'id.apps.example', AUTH_GOOGLE_CLIENT_SECRET: 'secret' })
        .auth.google,
    ).toEqual({ clientId: 'id.apps.example', clientSecret: 'secret' })
    expect(() => loadConfig({ ...env, AUTH_GOOGLE_CLIENT_ID: 'id.apps.example' })).toThrow(
      /auth.google.clientSecret/,
    )
  })

  test('previews are trusted by a pattern naming the site, and proxy OAuth only with a secret', () => {
    expect(loadConfig(env).auth.oauthProxy).toBeNull()
    const previews = {
      ...env,
      WEB_TRUSTED_ORIGINS: 'https://pr-*-blockly-web-staging.team.workers.dev',
      AUTH_OAUTH_PROXY_SECRET: 'a-proxy-secret-for-staging',
    }
    expect(loadConfig(previews).auth.oauthProxy).toEqual({ secret: 'a-proxy-secret-for-staging' })
    expect(() => loadConfig({ ...previews, AUTH_OAUTH_PROXY_SECRET: 'short' })).toThrow(
      /auth.oauthProxy.secret/,
    )
    for (const bare of ['https://*.workers.dev', 'https://*', 'https://preview.*.example.com'])
      expect(() => loadConfig({ ...previews, WEB_TRUSTED_ORIGINS: bare })).toThrow(/Name the site/)
  })

  test('an ACME certificate names what browsers dial, and needs the CA’s terms accepted', () => {
    const acme = {
      ...env,
      REALTIME_TLS_MODE: 'acme',
      REALTIME_TLS_HOSTNAME: 'rt.blockly.test',
      REALTIME_PUBLIC_URL: 'https://rt.blockly.test/',
      ACME_EMAIL: 'ops@blockly.test',
      ACME_AGREE_TOS: 'true',
      CLOUDFLARE_DNS_API_TOKEN: 'a-cloudflare-token-with-dns-edit',
      CLOUDFLARE_ZONE_ID: 'zone-123',
    }
    expect(loadConfig(acme).realtime.tls).toEqual({
      mode: 'acme',
      hostname: 'rt.blockly.test',
      directoryUrl: 'https://acme-v02.api.letsencrypt.org/directory',
      email: 'ops@blockly.test',
      agreeTos: true,
      dns01: { provider: 'cloudflare', apiToken: 'a-cloudflare-token-with-dns-edit', zoneId: 'zone-123' },
    })
    expect(
      loadConfig({ ...acme, ACME_DIRECTORY_URL: 'https://acme-staging-v02.api.letsencrypt.org/directory' })
        .realtime.tls,
    ).toMatchObject({ directoryUrl: 'https://acme-staging-v02.api.letsencrypt.org/directory' })
    expect(() => loadConfig({ ...acme, ACME_AGREE_TOS: undefined })).toThrow(/ACME_AGREE_TOS=true/)
    expect(() => loadConfig({ ...acme, CLOUDFLARE_ZONE_ID: '' })).toThrow(/dns01.zoneId/)
    expect(() => loadConfig({ ...acme, REALTIME_PUBLIC_URL: 'https://realtime.blockly.test/' })).toThrow(
      /the ACME certificate is for rt.blockly.test/,
    )
  })

  test('with no pooler in front of Postgres, the one URL serves the listener and migrations too', () => {
    expect(loadConfig(env).database).toMatchObject({ url: env.DATABASE_URL, directUrl: env.DATABASE_URL })
    const direct = 'postgres://blockly:blockly@127.0.0.1:5433/blockly'
    expect(loadConfig({ ...env, DATABASE_DIRECT_URL: direct }).database.directUrl).toBe(direct)
  })

  test('WebTransport on Fly listens on the port browsers dial, since Fly never rewrites a UDP port', () => {
    const fly = {
      ...env,
      REALTIME_PUBLIC_URL: 'https://rt.blockly.test/',
      REALTIME_LISTEN: 'fly-global-services:443',
    }
    expect(loadConfig(fly).realtime.listen).toBe('fly-global-services:443')
    expect(() => loadConfig({ ...fly, REALTIME_LISTEN: 'fly-global-services:7443' })).toThrow(
      /arrives on port 443, never at fly-global-services:7443/,
    )
    // A published port is the one to listen on.
    expect(
      loadConfig({
        ...fly,
        REALTIME_PUBLIC_URL: 'https://rt.blockly.test:7443/',
        REALTIME_LISTEN: 'fly-global-services:7443',
      }).realtime.listen,
    ).toBe('fly-global-services:7443')
  })

  test("the Fly runtime reads its org's log stream inside the org's network unless told otherwise", () => {
    const fly = {
      ...env,
      RUNTIME_PROVIDER: 'fly',
      FLY_ORG: 'blockly',
      FLY_API_TOKEN: 'FlyV1 fm2_0123456789abcdef',
    }
    expect(loadConfig(fly).runtimes[0]).toMatchObject({ provider: 'fly', natsUrl: 'nats://[fdaa::3]:4223' })
    expect(loadConfig({ ...fly, FLY_NATS_URL: 'nats://[fdaa:0:1a2b::3]:4223' }).runtimes[0]).toMatchObject({
      natsUrl: 'nats://[fdaa:0:1a2b::3]:4223',
    })
    expect(() => loadConfig({ ...fly, FLY_ORG: '' })).toThrow(/runtimes\.0\.org/)
  })

  test('the fake runtime runs only where the web origin is local', () => {
    const fake = { ...env, RUNTIME_PROVIDER: 'fake' }
    expect(loadConfig(fake).runtimes[0]?.provider).toBe('fake')
    expect(() => loadConfig({ ...fake, WEB_CANONICAL_ORIGIN: 'https://staging.cubepals.com' })).toThrow(
      /RUNTIME_PROVIDER=fake runs no real servers/,
    )
  })

  test('Docker has one region, since every server runs on the one machine, except to try more locally', () => {
    const two = { REGIONS: 'eu:Europe,us:North America', RUNTIME_REGION_MAP: 'eu:local,us:local' }
    expect(() => loadConfig({ ...deployed, ...two })).toThrow(/so it has one region; REGIONS lists 2/)
    expect(loadConfig({ ...env, ...two }).regions.map((region) => region.key)).toEqual(['eu', 'us'])
  })

  test('every region needs a placement', () => {
    expect(() => loadConfig({ ...env, REGIONS: 'local:Here,eu:Frankfurt' })).toThrow(/Region "eu"/)
  })

  test('an archive store is whole or absent, and runtimes may call it by another name', () => {
    const store = {
      ...env,
      ARCHIVE_S3_ENDPOINT: 'http://127.0.0.1:9000',
      ARCHIVE_S3_BUCKET: 'blockly-local',
      ARCHIVE_S3_ACCESS_KEY_ID: 'blockly',
      ARCHIVE_S3_SECRET_ACCESS_KEY: 'blockly-local-secret',
    }
    expect(loadConfig(store).archive).toMatchObject({ region: 'auto', runtimeEndpoint: null })
    expect(
      loadConfig({ ...store, ARCHIVE_S3_RUNTIME_ENDPOINT: 'http://host.docker.internal:9000' }).archive,
    ).toMatchObject({
      endpoint: 'http://127.0.0.1:9000',
      runtimeEndpoint: 'http://host.docker.internal:9000',
    })
    expect(() => loadConfig({ ...store, ARCHIVE_S3_BUCKET: '' })).toThrow(/archive.bucket/)
  })

  test('Polar billing names its server and sells every paid plan, and only paid plans', () => {
    const polar = {
      ...deployed,
      POLAR_ACCESS_TOKEN: 'polar_oat_0123456789abcdef',
      POLAR_WEBHOOK_SECRET: 'whsec_0123456789abcdef',
      POLAR_SERVER: 'sandbox',
      POLAR_PRODUCTS: 'plus:d8dd2de1-21b7-4a41-8bc3-ce909c0cfe23',
    }
    expect(loadConfig(deployed).billing).toBeNull()
    expect(loadConfig(polar).billing).toMatchObject({
      server: 'sandbox',
      products: { plus: 'd8dd2de1-21b7-4a41-8bc3-ce909c0cfe23' },
    })
    expect(() => loadConfig({ ...polar, POLAR_SERVER: undefined })).toThrow(/billing.server/)
    expect(() => loadConfig({ ...polar, POLAR_WEBHOOK_SECRET: 'plain' })).toThrow(/whsec_/)
    expect(() => loadConfig({ ...polar, POLAR_PRODUCTS: '' })).toThrow(/No Polar product sells the plus plan/)
    expect(() => loadConfig({ ...polar, POLAR_PRODUCTS: `${polar.POLAR_PRODUCTS},free:abc` })).toThrow(
      /"free", which isn't a paid plan/,
    )
  })

  test('mirroring needs an archive store', () => {
    expect(() => loadConfig({ ...env, ARTIFACTS_MIRROR: 'true' })).toThrow(/archive store/)
    expect(configFromEnv({ ...env, ARCHIVE_S3_ENDPOINT: 'http://127.0.0.1:9000' })).toMatchObject({
      archive: { endpoint: 'http://127.0.0.1:9000' },
    })
  })
})

describe('play addressing', () => {
  const addressing = new ConfiguredPlayAddressing({
    domain: 'play.example.gg',
    aliases: ['play.old.gg'],
    port: 25565,
  })

  test('addresses are the slug plus configuration, in both directions', () => {
    expect(addressing.primary('sunset')).toEqual({ hostname: 'sunset.play.example.gg', port: 25565 })
    expect(addressing.all('sunset').map((a) => a.hostname)).toEqual([
      'sunset.play.example.gg',
      'sunset.play.old.gg',
    ])
    for (const address of addressing.all('sunset'))
      expect(addressing.slugFor(address.hostname)).toBe('sunset')
  })

  test('hostnames are normalized, and anything not ours is null', () => {
    expect(addressing.slugFor('SUNSET.Play.Example.GG.')).toBe('sunset')
    expect(addressing.slugFor('sunset.play.example.gg:25565')).toBe('sunset')
    expect(addressing.slugFor('a.b.play.example.gg')).toBeNull()
    expect(addressing.slugFor('sunset.example.gg')).toBeNull()
    expect(addressing.slugFor('api.play.example.gg')).toBeNull()
  })

  test('each hostname names the play domain it came through, primary or alias (§11)', () => {
    expect(addressing.domains()).toEqual([
      { domain: 'play.example.gg', alias: false },
      { domain: 'play.old.gg', alias: true },
    ])
    expect(addressing.domainFor('Sunset.Play.Old.GG.:25565')).toBe('play.old.gg')
    expect(addressing.domainFor('sunset.play.example.gg')).toBe('play.example.gg')
    expect(addressing.domainFor('sunset.example.gg')).toBeNull()
  })
})

describe('PostHog', () => {
  test('PostHog is off without its token, and says which environment sent each event', () => {
    expect(loadConfig(env).insight).toBeNull()
    const token = 'phc_stand-in-project-token'
    expect(loadConfig({ ...env, POSTHOG_TOKEN: token }).insight).toEqual({
      token,
      host: 'https://eu.i.posthog.com',
      environment: 'development',
    })
    // The deployment's own id says which it is, never the address it is reached at.
    expect(
      loadConfig({ ...deployed, DEPLOYMENT_ID: 'prod', POSTHOG_TOKEN: token }).insight?.environment,
    ).toBe('production')
    expect(
      loadConfig({ ...deployed, DEPLOYMENT_ID: 'staging', POSTHOG_TOKEN: token }).insight?.environment,
    ).toBe('staging')
    expect(() => loadConfig({ ...env, POSTHOG_TOKEN: 'phx_personal' })).toThrow(/POSTHOG_TOKEN/)
  })
})

describe('mail', () => {
  test("staging's subjects say so, by the deployment's own id; nobody else's carry anything", () => {
    expect(loadConfig({ ...deployed, DEPLOYMENT_ID: 'staging' }).mail.subjectPrefix).toBe('[Staging] ')
    expect(loadConfig({ ...deployed, DEPLOYMENT_ID: 'prod' }).mail.subjectPrefix).toBe('')
    expect(loadConfig(env).mail.subjectPrefix).toBe('')
  })
})

describe("staging's pull request previews", () => {
  const previews = 'https://pr-*-blockly-web-staging.team.workers.dev'

  test('are trusted by the Worker’s name and the account’s workers.dev subdomain', () => {
    expect(loadConfig({ ...env, WEB_TRUSTED_ORIGINS: previews }).web.trustedOrigins).toEqual([previews])
  })

  test('are never trusted by a pattern another account’s Worker could match', () => {
    for (const anyone of ['https://pr-*-blockly-web-staging.workers.dev', 'https://*.team.workers.dev'])
      expect(() => loadConfig({ ...env, WEB_TRUSTED_ORIGINS: anyone })).toThrow(/Name the site/)
  })
})
