import { describe, expect, test } from 'bun:test'
import { PNG } from 'pngjs'
import { MojangProfiles } from './profiles.ts'

const UUID = '069a79f444e94726a5befca90e38aaf5'

/** A 64×64 skin, all one colour. */
function skinPng(): Buffer {
  const png = new PNG({ width: 64, height: 64 })
  png.data.fill(200)
  return PNG.sync.write(png)
}

/** A session-server profile listing these textures, the way Mojang encodes them. */
function listing(textures: object): Response {
  const value = Buffer.from(JSON.stringify({ profileId: UUID, textures })).toString('base64')
  return Response.json({ id: UUID, name: 'Notch', properties: [{ name: 'textures', value }] })
}

function fakeFetch(answer: (url: URL) => Response) {
  const asked: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    asked.push(url.href)
    return answer(url)
  }) as typeof globalThis.fetch
  return { fetch, asked }
}

describe('skins from Mojang', () => {
  test('the listed skin, fetched over https from Mojang’s texture host and decoded', async () => {
    const { fetch, asked } = fakeFetch((url) =>
      url.hostname === 'textures.minecraft.net'
        ? new Response(new Uint8Array(skinPng()))
        : listing({ SKIN: { url: 'http://textures.minecraft.net/texture/abc123' } }),
    )
    const skin = await new MojangProfiles({ fetch }).skinOf(UUID)
    expect(skin?.width).toBe(64)
    expect(skin?.height).toBe(64)
    expect(skin?.rgba.length).toBe(64 * 64 * 4)
    expect(asked).toEqual([
      `https://sessionserver.mojang.com/session/minecraft/profile/${UUID}`,
      'https://textures.minecraft.net/texture/abc123',
    ])
  })

  test('none for an account wearing a default skin, or no account at all', async () => {
    const bare = fakeFetch(() => listing({}))
    expect(await new MojangProfiles({ fetch: bare.fetch }).skinOf(UUID)).toBeNull()
    const nobody = fakeFetch(() => new Response(null, { status: 204 }))
    expect(await new MojangProfiles({ fetch: nobody.fetch }).skinOf(UUID)).toBeNull()
  })

  test('a texture anywhere but Mojang’s host is never fetched', async () => {
    const { fetch, asked } = fakeFetch(() => listing({ SKIN: { url: 'http://169.254.169.254/latest' } }))
    expect(await new MojangProfiles({ fetch }).skinOf(UUID)).toBeNull()
    expect(asked).toHaveLength(1)
  })

  test('Mojang refusing is an error, not a player without a skin', async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 429 }))
    await expect(new MojangProfiles({ fetch }).skinOf(UUID)).rejects.toThrow('Mojang answered 429')
  })
})
