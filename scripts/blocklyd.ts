// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The blocklyd this control plane hands its hosts: one release of cubepals/blocklyd, pinned by
 * digest in apps/control/Dockerfile, with copies of the release's files the control plane reads
 * kept beside its fleet adapter (apps/control/src/infra/fleet): the two OpenAPI documents its wire
 * types are generated from, and the daemon.json join.sh gives a host's Docker. Typecheck, tests and
 * the node endpoint read the copies, so none of them needs Rust or the image.
 *
 *   bun scripts/blocklyd.ts version        the pinned version, alone, for scripts
 *   bun scripts/blocklyd.ts bump <version> pin that release: the Dockerfile's line, the copies, then
 *                                          `bun run openapi:generate`
 *   bun scripts/blocklyd.ts check          the copies are the pinned release's files, byte for byte,
 *                                          and its tag still names the pinned digest (fleet.yml)
 *
 * Releases are immutable, so what `check` passed once it passes until a file here changes. Taking a
 * new release is its own pull request, whose fleet e2e runs against it (fleet.yml).
 */
import { readFileSync, writeFileSync } from 'node:fs'

const REPO = 'cubepals/blocklyd'
const IMAGE = `ghcr.io/${REPO}`
const DOCKERFILE = 'apps/control/Dockerfile'
const FLEET = 'apps/control/src/infra/fleet'
/** Each release file the control plane keeps a copy of, and where. */
const COPIES: Record<string, string> = {
  'node-reads.openapi.json': `${FLEET}/node-reads.openapi.json`,
  'node-writes.openapi.json': `${FLEET}/node-writes.openapi.json`,
  'daemon.json': `${FLEET}/daemon.json`,
}
const PIN = /^FROM ghcr\.io\/cubepals\/blocklyd:(\d+\.\d+\.\d+)@(sha256:[0-9a-f]{64}) AS blocklyd$/m

function pinned(): { version: string; digest: string } {
  const match = PIN.exec(readFileSync(DOCKERFILE, 'utf8'))
  if (match === null)
    throw new Error(`${DOCKERFILE} has no \`FROM ${IMAGE}:<version>@sha256:… AS blocklyd\` line`)
  return { version: match[1] as string, digest: match[2] as string }
}

async function asset(version: string, name: string): Promise<string> {
  const url = `https://github.com/${REPO}/releases/download/v${version}/${name}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}. Is v${version} released?`)
  return response.text()
}

/** The digest the registry gives the version's tag, asked anonymously as any public pull is. */
async function digestOf(version: string): Promise<string> {
  const auth = await fetch(`https://ghcr.io/token?scope=repository:${REPO}:pull`)
  const { token } = (await auth.json()) as { token: string }
  const response = await fetch(`https://ghcr.io/v2/${REPO}/manifests/${version}`, {
    method: 'HEAD',
    headers: {
      authorization: `Bearer ${token}`,
      accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(', '),
    },
  })
  const digest = response.headers.get('docker-content-digest')
  if (!response.ok || digest === null) throw new Error(`${IMAGE}:${version}: ${response.status}, no digest`)
  return digest
}

async function bump(version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`bump takes a version such as 0.3.0, not ${version}`)
  const digest = await digestOf(version)
  const dockerfile = readFileSync(DOCKERFILE, 'utf8')
  if (!PIN.test(dockerfile))
    throw new Error(`${DOCKERFILE} has no \`FROM ${IMAGE}:<version>@sha256:… AS blocklyd\` line`)
  writeFileSync(DOCKERFILE, dockerfile.replace(PIN, `FROM ${IMAGE}:${version}@${digest} AS blocklyd`))
  for (const [name, path] of Object.entries(COPIES)) writeFileSync(path, await asset(version, name))
  const generate = Bun.spawnSync(['bun', 'run', 'openapi:generate'], { stdout: 'inherit', stderr: 'inherit' })
  if (generate.exitCode !== 0) process.exit(generate.exitCode ?? 1)
  console.warn(`Pinned blocklyd ${version} (${digest}). Commit ${DOCKERFILE}, ${FLEET} and its generated/.`)
}

async function check() {
  const { version, digest } = pinned()
  const problems: string[] = []
  const tagged = await digestOf(version)
  if (tagged !== digest) problems.push(`${IMAGE}:${version} is ${tagged}, but ${DOCKERFILE} pins ${digest}`)
  for (const [name, path] of Object.entries(COPIES))
    if (readFileSync(path, 'utf8') !== (await asset(version, name)))
      problems.push(`${path} is not v${version}'s ${name}`)
  if (problems.length > 0) {
    console.error(`${problems.join('\n')}\nRun \`bun scripts/blocklyd.ts bump ${version}\`.`)
    process.exit(1)
  }
  console.warn(`blocklyd ${version}: the pin and its copies match the release.`)
}

const [command, argument] = process.argv.slice(2)
if (command === 'version') process.stdout.write(`${pinned().version}\n`)
else if (command === 'bump' && argument !== undefined) await bump(argument)
else if (command === 'check') await check()
else {
  console.error('usage: bun scripts/blocklyd.ts version | bump <version> | check')
  process.exit(2)
}
