// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_ABUSE_LIMITS,
  DEFAULT_CAPACITY_TUNING,
  DEFAULT_ECONOMICS_TUNING,
  DEFAULT_FREE_LINK_TUNING,
} from '../domain/account/tuning.ts'
import { DEFAULT_ROOM } from '../domain/policy/room.ts'
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

/** Production's private tuning, which only production must set: here, the defaults as JSON. */
const tuned = {
  FREE_LINK_TUNING: JSON.stringify(DEFAULT_FREE_LINK_TUNING),
  ABUSE_LIMITS: JSON.stringify(DEFAULT_ABUSE_LIMITS),
  CAPACITY_TUNING: JSON.stringify(DEFAULT_CAPACITY_TUNING),
}

describe('server operations', () => {
  test('run 32 at once, with 8 more for starts and wakes, unless told otherwise', () => {
    expect(loadConfig(env).operations).toEqual({ concurrency: 32, wakeConcurrency: 8 })
    expect(
      loadConfig({ ...env, SERVER_OPERATIONS_CONCURRENCY: '64', SERVER_WAKES_CONCURRENCY: '12' }).operations,
    ).toEqual({ concurrency: 64, wakeConcurrency: 12 })
    for (const wrong of ['0', '-1', '2.5', 'many'])
      expect(() => loadConfig({ ...env, SERVER_OPERATIONS_CONCURRENCY: wrong })).toThrow()
    expect(() => loadConfig({ ...env, SERVER_WAKES_CONCURRENCY: '0' })).toThrow()
  })
})

/** The products a deployment sells, one for each paid plan, the smallest plan first. */
const PRODUCTS = {
  core: '64a34283-3a76-4110-8db7-034c2ff23207',
  plus: 'd8dd2de1-21b7-4a41-8bc3-ce909c0cfe23',
}

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
      POLAR_PRODUCTS: 'core:64a34283-3a76-4110-8db7-034c2ff23207,plus:d8dd2de1-21b7-4a41-8bc3-ce909c0cfe23',
    }
    expect(loadConfig(deployed).billing).toBeNull()
    expect(loadConfig(polar).billing).toMatchObject({
      server: 'sandbox',
      products: PRODUCTS,
    })
    expect(() => loadConfig({ ...polar, POLAR_SERVER: undefined })).toThrow(/billing.server/)
    expect(() => loadConfig({ ...polar, POLAR_WEBHOOK_SECRET: 'plain' })).toThrow(/whsec_/)
    expect(() => loadConfig({ ...polar, POLAR_PRODUCTS: '' })).toThrow(/POLAR_PRODUCTS names no product/)
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

  test('a kept address answers with the slug of the server it points at, under every play domain', () => {
    expect(addressing.slugFor('sunset-valley.play.example.gg')).toBe('arcade')
    expect(addressing.slugFor('Sunset-Valley.play.old.gg.')).toBe('arcade')
    expect(addressing.slugFor('copper-cove.play.example.gg')).toBe('arcade')
    expect(addressing.slugFor('Maple-Hollow.play.old.gg.')).toBe('arcade')
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
      loadConfig({ ...deployed, ...tuned, DEPLOYMENT_ID: 'prod', POSTHOG_TOKEN: token }).insight?.environment,
    ).toBe('production')
    expect(
      loadConfig({ ...deployed, DEPLOYMENT_ID: 'staging', POSTHOG_TOKEN: token }).insight?.environment,
    ).toBe('staging')
    expect(() => loadConfig({ ...env, POSTHOG_TOKEN: 'phx_personal' })).toThrow(/POSTHOG_TOKEN/)
  })
})

describe('private tuning', () => {
  const free = { ...DEFAULT_FREE_LINK_TUNING, link: 0.2, medium: 0.5, high: 0.8 }
  const abuse = { ...DEFAULT_ABUSE_LIMITS, giftsPerDay: 2 }

  test('is read from its JSON, and is the default where none is set outside production', () => {
    const config = loadConfig({
      ...env,
      FREE_LINK_TUNING: JSON.stringify(free),
      ABUSE_LIMITS: JSON.stringify(abuse),
    })
    expect([config.freeLinkTuning, config.abuseLimits]).toEqual([free, abuse])
    expect(loadConfig(env).freeLinkTuning).toEqual(DEFAULT_FREE_LINK_TUNING)
    expect(loadConfig({ ...deployed, DEPLOYMENT_ID: 'staging' }).abuseLimits).toEqual(DEFAULT_ABUSE_LIMITS)
    const capacity = { ...DEFAULT_CAPACITY_TUNING, tightIdleMinutes: 4 }
    expect(loadConfig({ ...env, CAPACITY_TUNING: JSON.stringify(capacity) }).capacityTuning).toEqual(capacity)
    expect(loadConfig(env).capacityTuning).toEqual(DEFAULT_CAPACITY_TUNING)
  })

  test('the economics figures are read from their JSON, default outside production, and are left out when unset there', () => {
    const economics = { paymentFee: { percent: 4, fixedCents: 20 }, archiveGbMonthCents: 2 }
    expect(loadConfig({ ...env, ECONOMICS_TUNING: JSON.stringify(economics) }).economicsTuning).toEqual(
      economics,
    )
    expect(loadConfig(env).economicsTuning).toEqual(DEFAULT_ECONOMICS_TUNING)
    const prod = { ...deployed, ...tuned, DEPLOYMENT_ID: 'prod' }
    expect(loadConfig(prod).economicsTuning).toBeNull()
    expect(() => loadConfig({ ...env, ECONOMICS_TUNING: '{"paymentFee":1}' })).toThrow(/economicsTuning/)
  })

  test('the room kept for wakes and the wait creates may have are the defaults unless set', () => {
    expect(loadConfig(env).room).toEqual(DEFAULT_ROOM)
    expect(loadConfig({ ...env, WAKE_RESERVE: '0', CREATE_WAIT_SECONDS: '30' }).room).toEqual({
      wakeReserve: 0,
      createWaitSeconds: 30,
    })
    expect(() => loadConfig({ ...env, WAKE_RESERVE: '-1' })).toThrow(/wakeReserve/)
  })

  test('a deployment’s limits from before the invite cap existed take its default', () => {
    const { inviteJoinsPerHour: _, ...older } = abuse
    expect(loadConfig({ ...env, ABUSE_LIMITS: JSON.stringify(older) }).abuseLimits).toEqual(abuse)
    const wider = { ...abuse, inviteJoinsPerHour: 40 }
    expect(loadConfig({ ...env, ABUSE_LIMITS: JSON.stringify(wider) }).abuseLimits).toEqual(wider)
  })

  test('a deployment’s limits from before the world upload cap existed take its default', () => {
    const { worldUploadsPerDay: _, ...older } = abuse
    expect(loadConfig({ ...env, ABUSE_LIMITS: JSON.stringify(older) }).abuseLimits).toEqual(abuse)
  })

  test('production refuses to start without it, and any deployment with it wrong', () => {
    const prod = { ...deployed, DEPLOYMENT_ID: 'prod' }
    const { FREE_LINK_TUNING: _f, ...noLinks } = tuned
    const { ABUSE_LIMITS: _a, ...noAbuse } = tuned
    const { CAPACITY_TUNING: _c, ...noCapacity } = tuned
    expect(() => loadConfig({ ...prod, ...noLinks })).toThrow(/FREE_LINK_TUNING/)
    expect(() => loadConfig({ ...prod, ...noAbuse })).toThrow(/ABUSE_LIMITS/)
    expect(() => loadConfig({ ...prod, ...noCapacity })).toThrow(/CAPACITY_TUNING/)
    expect(() => loadConfig({ ...env, CAPACITY_TUNING: JSON.stringify({ freeShare: 2 }) })).toThrow(
      /capacityTuning/,
    )
    expect(() => loadConfig({ ...env, FREE_LINK_TUNING: '{not json' })).toThrow(/FREE_LINK_TUNING/)
    const disordered = { ...free, medium: free.high, high: free.medium }
    expect(() => loadConfig({ ...env, FREE_LINK_TUNING: JSON.stringify(disordered) })).toThrow(
      /link < medium < high/,
    )
    const { giftsPerDay: _, ...short } = abuse
    expect(() => loadConfig({ ...env, ABUSE_LIMITS: JSON.stringify(short) })).toThrow(/abuseLimits/)
    const ceilings = { ...abuse, extraCeiling: { untilRenewed: 9, renewed: 3 } }
    expect(() => loadConfig({ ...env, ABUSE_LIMITS: JSON.stringify(ceilings) })).toThrow(/extraCeiling/)
  })
})

describe('mail', () => {
  test("staging's subjects say so, by the deployment's own id; nobody else's carry anything", () => {
    expect(loadConfig({ ...deployed, DEPLOYMENT_ID: 'staging' }).mail.subjectPrefix).toBe('[Staging] ')
    expect(loadConfig({ ...deployed, ...tuned, DEPLOYMENT_ID: 'prod' }).mail.subjectPrefix).toBe('')
    expect(loadConfig(env).mail.subjectPrefix).toBe('')
  })

  test("sign-in's own emails come from the account sender, or the everyday one without it", () => {
    expect(loadConfig(env).mail.accountFrom).toBe('Cubepals <hello@localhost>')
    expect(loadConfig({ ...env, MAIL_ACCOUNT_FROM: '' }).mail.accountFrom).toBe('Cubepals <hello@localhost>')
    expect(loadConfig({ ...env, MAIL_ACCOUNT_FROM: 'Cubepals <account@localhost>' }).mail).toMatchObject({
      from: 'Cubepals <hello@localhost>',
      accountFrom: 'Cubepals <account@localhost>',
    })
  })

  test('notices come from their own sender, or the everyday one without it', () => {
    expect(loadConfig(env).mail.noticeFrom).toBe('Cubepals <hello@localhost>')
    expect(loadConfig({ ...env, MAIL_NOTICE_FROM: '' }).mail.noticeFrom).toBe('Cubepals <hello@localhost>')
    expect(loadConfig({ ...env, MAIL_NOTICE_FROM: 'Cubepals <noreply@localhost>' }).mail).toMatchObject({
      from: 'Cubepals <hello@localhost>',
      accountFrom: 'Cubepals <hello@localhost>',
      noticeFrom: 'Cubepals <noreply@localhost>',
    })
  })

  test('admin mail has its own inbox when one is named, apart from who is an admin', () => {
    const config = loadConfig({
      ...env,
      ADMIN_EMAILS: 'owner@example.test',
      ADMIN_ALERT_EMAILS: 'alerts@example.test, oncall@example.test',
    })
    expect(config.mail.adminInbox).toEqual(['alerts@example.test', 'oncall@example.test'])
    expect(config.auth.admins).toEqual(['owner@example.test'])
    expect(loadConfig(env).mail.adminInbox).toEqual([])
    expect(() => loadConfig({ ...env, ADMIN_ALERT_EMAILS: 'not-an-email' })).toThrow()
  })
})

describe("staging's pull request previews", () => {
  const previews = 'https://pr-*-blockly-web-staging.team.workers.dev'

  test('are trusted by the Worker’s name and the account’s workers.dev subdomain', () => {
    expect(loadConfig({ ...env, WEB_TRUSTED_ORIGINS: previews }).web.trustedOrigins).toEqual([previews])
  })

  test('are never trusted by a pattern another account’s Worker could match', () => {
    for (const anyone of [
      'https://pr-*-blockly-web-staging.workers.dev',
      'https://*.team.workers.dev',
      'https://???????.workers.dev',
      'https://abc.???.workers.dev',
    ])
      expect(() => loadConfig({ ...env, WEB_TRUSTED_ORIGINS: anyone })).toThrow(/Name the site/)
  })

  test('each previewed commit is trusted by its address’s shape on the site’s own domain', () => {
    const commits = 'https://???????.preview.cubepals.com'
    expect(loadConfig({ ...env, WEB_TRUSTED_ORIGINS: commits }).web.trustedOrigins).toEqual([commits])
  })
})

describe('join records', () => {
  test('unset, no server gets the reporter and no signal is judged', () => {
    expect(loadConfig(env).joins).toEqual({ reporter: 'off' })
  })

  test('JOIN_REPORTER picks the servers, and SIGNALS is read as JSON for the signals job to judge', () => {
    const config = loadConfig({ ...env, JOIN_REPORTER: 'official', SIGNALS: '{"watchedAddresses":["x"]}' })
    expect(config.joins).toEqual({ reporter: 'official', signals: { watchedAddresses: ['x'] } })
    expect(() => loadConfig({ ...env, JOIN_REPORTER: 'some' })).toThrow()
  })
})

describe('STOP_CHEATERS', () => {
  const fixture = {
    punishments: 'Punishments: {}\n',
    ban: { reason: 'impossible' as const, removals: 2, withinMinutes: 10, minutes: 30 },
  }

  test('is read from its JSON; unset or unreadable is the public default, with the reason', () => {
    expect(loadConfig({ ...env, STOP_CHEATERS: JSON.stringify(fixture) }).stopCheaters).toEqual({
      tuning: fixture,
      problem: null,
    })
    expect(loadConfig(env).stopCheaters).toEqual({ tuning: null, problem: null })
    for (const value of [
      '{not json',
      '[]',
      JSON.stringify({ punishments: '', ban: fixture.ban }),
      JSON.stringify({ ...fixture, ban: { ...fixture.ban, reason: 'speed' } }),
      JSON.stringify({ ...fixture, ban: { ...fixture.ban, removals: 0 } }),
      JSON.stringify({ ...fixture, extra: true }),
    ])
      expect(loadConfig({ ...env, STOP_CHEATERS: value }).stopCheaters).toEqual({
        tuning: null,
        problem: 'invalid',
      })
  })
})

describe('Polar products', () => {
  test('a paid plan with no product is not for sale yet: plus alone, core alone and both all start', () => {
    const polar = {
      ...deployed,
      POLAR_ACCESS_TOKEN: 'polar_oat_0123456789abcdef',
      POLAR_WEBHOOK_SECRET: 'whsec_0123456789abcdef',
      POLAR_SERVER: 'sandbox',
    }
    const products = (value: string) => loadConfig({ ...polar, POLAR_PRODUCTS: value }).billing
    expect(products('plus:p1')).toMatchObject({ products: { plus: 'p1' } })
    expect(products('core:c1')).toMatchObject({ products: { core: 'c1' } })
    // Listed in any order, smallest plan first.
    expect(Object.keys((products('plus:p1,core:c1') as { products: object }).products)).toEqual([
      'core',
      'plus',
    ])
  })
})
