// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The deploy's server image step: its tags, the registry asked for them, and a deploy that builds
 * only what is missing and goes on past a build that stops.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  buildServerImages,
  inRegistry,
  SERVER_DOCKERFILE,
  SERVER_IMAGE_BUILDS,
  serverImageTag,
} from './production-server-images.ts'

const DOCKERFILE = readFileSync(SERVER_DOCKERFILE, 'utf8')

describe('a server image tag', () => {
  test('is the same for the same Dockerfile and arguments, in any order', () => {
    const a = serverImageTag(25, { BASE: 'x', MC_HELPER_VERSION: 'y' }, DOCKERFILE)
    const b = serverImageTag(25, { MC_HELPER_VERSION: 'y', BASE: 'x' }, DOCKERFILE)
    expect(a).toBe(b)
    expect(a).toMatch(/^server-java25-[0-9a-f]{12}$/)
  })

  test('changes with the Dockerfile, an argument or the Java', () => {
    const tag = serverImageTag(25, { BASE: 'x' }, DOCKERFILE)
    expect(serverImageTag(25, { BASE: 'x' }, `${DOCKERFILE}\n# changed`)).not.toBe(tag)
    expect(serverImageTag(25, { BASE: 'y' }, DOCKERFILE)).not.toBe(tag)
    expect(serverImageTag(21, { BASE: 'x' }, DOCKERFILE)).not.toBe(tag)
  })

  test('is built for each Java a server runs, Java 8 with the helper that runs on it', () => {
    expect(SERVER_IMAGE_BUILDS.map((b) => b.java)).toEqual([25, 21, 17, 8])
    expect(SERVER_IMAGE_BUILDS.find((b) => b.java === 8)?.args.MC_HELPER_VERSION).toBe('1.51.4-java8')
    // Each base named in the Dockerfile's header is the one built.
    for (const { args } of SERVER_IMAGE_BUILDS)
      expect(DOCKERFILE).toContain((args.BASE ?? '').replace('mirror.gcr.io/library/', ''))
  })
})

describe('the registry is asked', () => {
  const answering = (status: number) => {
    const asked: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetcher = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init })
      return new Response(null, { status })
    }) as unknown as typeof fetch
    return { asked, fetcher }
  }

  test('with a HEAD on the tag, signed in with the token', async () => {
    const { asked, fetcher } = answering(200)
    expect(await inRegistry('bly-prod-control', 'server-java25-abc', 'secret', fetcher)).toBe(true)
    expect(asked[0]?.url).toBe('https://registry.fly.io/v2/bly-prod-control/manifests/server-java25-abc')
    expect(asked[0]?.init?.method).toBe('HEAD')
    const headers = asked[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('x:secret').toString('base64')}`)
  })

  test('a tag not there is false; any other answer is an error', async () => {
    expect(await inRegistry('a', 't', 'k', answering(404).fetcher)).toBe(false)
    await expect(inRegistry('a', 't', 'k', answering(401).fetcher)).rejects.toThrow('answered 401')
  })
})

describe('the deploy step', () => {
  const run = async (exists: (tag: string) => Promise<boolean>, builds: boolean) => {
    const said: string[] = []
    const built: Array<{ tag: string; args: Readonly<Record<string, string>> }> = []
    const ready = await buildServerImages('bly-prod-control', (line) => said.push(line), {
      exists,
      build: (tag, args) => {
        built.push({ tag, args })
        return builds
      },
      dockerfile: DOCKERFILE,
      now: () => 0,
    })
    return { said, built, ready }
  }

  test('builds nothing where every tag is there', async () => {
    const { built, ready, said } = await run(async () => true, true)
    expect(built).toEqual([])
    expect(ready).toHaveLength(4)
    expect(said.every((line) => line.includes('is there already'))).toBe(true)
  })

  test('builds only the tags that are missing, with their arguments', async () => {
    const java8 = SERVER_IMAGE_BUILDS.find((b) => b.java === 8)
    const missing = serverImageTag(8, java8?.args ?? {}, DOCKERFILE)
    const { built, ready } = await run(async (tag) => tag !== missing, true)
    expect(built).toEqual([{ tag: missing, args: java8?.args ?? {} }])
    expect(ready).toContain(`registry.fly.io/bly-prod-control:${missing}`)
  })

  test('goes on, saying so, when a build stops or the registry can’t be asked', async () => {
    const stopped = await run(async () => false, false)
    expect(stopped.ready).toEqual([])
    expect(stopped.said.every((line) => line.includes('the deploy goes on'))).toBe(true)
    const unasked = await run(async () => {
      throw new Error('registry.fly.io answered 500')
    }, true)
    expect(unasked.built).toEqual([])
    expect(unasked.said[0]).toContain("couldn't ask the registry (registry.fly.io answered 500)")
  })
})
