// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cubepals' own server image (`images/minecraft-server/Dockerfile`), built by production's deploy
 * for each Java a server runs and pushed to the control app's repository in Fly's registry, where
 * every app of the organization can pull it. Each is tagged by what it is built from, the
 * Dockerfile and its arguments, so a deploy that changes neither asks the registry and builds
 * nothing. Nothing runs these images until a server is pinned to one; a build that fails is said and
 * the deploy goes on.
 *
 * Not for: choosing which image a server runs (`imageFor`, apps/control/src/minecraft/runtime-spec.ts).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const SERVER_DOCKERFILE = resolve(import.meta.dir, '..', 'images', 'minecraft-server', 'Dockerfile')

const MIRROR = 'mirror.gcr.io/library/eclipse-temurin'

/** Each Java `javaFor` picks, on the base itzg builds it on at the pinned release (the Dockerfile's header). */
export const SERVER_IMAGE_BUILDS: ReadonlyArray<{ java: number; args: Readonly<Record<string, string>> }> = [
  { java: 25, args: { BASE: `${MIRROR}:25-jre` } },
  { java: 21, args: { BASE: `${MIRROR}:21-jre` } },
  { java: 17, args: { BASE: `${MIRROR}:17-jre-focal` } },
  { java: 8, args: { BASE: `${MIRROR}:8u312-b07-jre-focal`, MC_HELPER_VERSION: '1.51.4-java8' } },
]

/** `server-java25-<12 hex>`: the Java, and a hash of the Dockerfile and the arguments it is built with. */
export function serverImageTag(
  java: number,
  args: Readonly<Record<string, string>>,
  dockerfile: string,
): string {
  const sorted = Object.keys(args)
    .sort()
    .map((name) => `${name}=${args[name]}`)
  const hash = createHash('sha256').update(dockerfile).update('\0').update(sorted.join('\n')).digest('hex')
  return `server-java${java}-${hash.slice(0, 12)}`
}

/**
 * Whether the registry holds `tag` in the app's repository: a HEAD on its manifest, signed in with
 * the Fly token. Fly has no API that lists tags (docs.fly.io/blueprints/using-the-fly-docker-registry).
 */
export async function inRegistry(
  app: string,
  tag: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetcher(`https://registry.fly.io/v2/${app}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}`,
      Accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(', '),
    },
  })
  if (response.status === 200) return true
  if (response.status === 404) return false
  throw new Error(`registry.fly.io answered ${response.status} for ${app}:${tag}`)
}

/** `fly deploy --build-only --push` of the server image, as the apps' own images are built (production-edge-deploy.ts). */
function flyBuild(
  app: string,
  config: string,
  tag: string,
  args: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv,
) {
  const flags = ['deploy', dirname(SERVER_DOCKERFILE), '--build-only', '--push', '--remote-only']
  flags.push('--dockerfile', SERVER_DOCKERFILE, '--image-label', tag, '--config', config, '--app', app)
  for (const [name, value] of Object.entries(args)) flags.push('--build-arg', `${name}=${value}`)
  let built = spawnSync('fly', flags, { stdio: 'inherit', env })
  // Depot's builders speak gRPC over TLS, which an intercepting proxy breaks; Fly's own come in over WireGuard.
  if (built.status !== 0) built = spawnSync('fly', [...flags, '--depot=false'], { stdio: 'inherit', env })
  return built.status === 0
}

export interface ServerImageDeps {
  exists: (tag: string) => Promise<boolean>
  build: (tag: string, args: Readonly<Record<string, string>>) => boolean
  dockerfile: string
  now: () => number
}

/**
 * Each Java's image in the app's repository: built where its tag isn't there yet, and said either
 * way, with how long it took. Returns the references now in the registry.
 */
export async function buildServerImages(
  app: string,
  say: (line: string) => void,
  deps: ServerImageDeps,
): Promise<string[]> {
  const ready: string[] = []
  for (const { java, args } of SERVER_IMAGE_BUILDS) {
    const tag = serverImageTag(java, args, deps.dockerfile)
    const reference = `registry.fly.io/${app}:${tag}`
    const started = deps.now()
    const seconds = () => ((deps.now() - started) / 1000).toFixed(1)
    try {
      if (await deps.exists(tag)) {
        say(`Server image for Java ${java}: ${reference} is there already (${seconds()} s to ask).`)
        ready.push(reference)
      } else if (deps.build(tag, args)) {
        say(`Server image for Java ${java}: built and pushed ${reference} in ${seconds()} s.`)
        ready.push(reference)
      } else {
        say(
          `Server image for Java ${java}: the build of ${reference} stopped; no server runs it, so the deploy goes on.`,
        )
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      say(
        `Server image for Java ${java}: couldn't ask the registry (${why}); no server runs it, so the deploy goes on.`,
      )
    }
  }
  return ready
}

/** The deploy's step: production's control app, with the token flyctl is given. */
export function productionServerImages(
  app: string,
  config: string,
  env: NodeJS.ProcessEnv,
  say: (line: string) => void,
): Promise<string[]> {
  const token = env.FLY_API_TOKEN ?? ''
  return buildServerImages(app, say, {
    exists: (tag) => inRegistry(app, tag, token),
    build: (tag, args) => flyBuild(app, config, tag, args, env),
    dockerfile: readFileSync(SERVER_DOCKERFILE, 'utf8'),
    now: Date.now,
  })
}
