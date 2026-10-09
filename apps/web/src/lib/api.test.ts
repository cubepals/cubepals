import { describe, expect, test } from 'bun:test'
import { TRPCClientError } from '@trpc/client'
import { messageOf } from './api.tsx'

describe('what a failed request says', () => {
  test('a refusal from the API, in its own words', () => {
    const refused = TRPCClientError.from({
      error: {
        code: -32600,
        message: 'That address is taken — try adding a word.',
        data: { code: 'BAD_REQUEST' },
      },
    })
    expect(messageOf(refused)).toBe('That address is taken — try adding a word.')
  })

  test('no answer at all is the connection, never the browser’s own words for it', () => {
    for (const said of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'])
      expect(messageOf(TRPCClientError.from(new TypeError(said)))).toBe(
        'Cubepals couldn’t be reached. Check your connection and try again.',
      )
  })
})
