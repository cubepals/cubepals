import { describe, expect, test } from 'bun:test'
import { FakeProfiles } from '../../infra/fake/fake-profiles.ts'
import { identityFor, keyedFor, offlineUuid } from './identity.ts'

describe('who a player is to a server', () => {
  test('a server that does not verify accounts derives the player from the exact name', () => {
    // Each of these is what a real server wrote or logged for that name (2026-09-19, 2026-09-23):
    // vanilla 26.1's `list uuids`, and the whitelist, operator and ban files of vanilla 26.1 and
    // Paper 1.21.8 in offline mode.
    expect(offlineUuid('PresenceBot')).toBe('2289dfb4-69e8-34dd-94a2-8862994e2feb')
    expect(offlineUuid('BotOne')).toBe('9d235a47-ec7d-3184-8776-7263a6ae7d5c')
    expect(offlineUuid('OpBot')).toBe('b6a1b65e-f37d-32c1-9852-69a39a550592')
    expect(offlineUuid('NewGuy')).toBe('1d93c198-06e3-3b59-8cd5-087d7de1d56f')
    // Capitals are part of the name: to such a server these are two different players.
    expect(offlineUuid('newguy')).not.toBe(offlineUuid('NewGuy'))
  })

  test('the name is enough without verification; with it, the account decides', async () => {
    const profiles = new FakeProfiles()
    profiles.unknown('NoAccountHere')
    expect(await identityFor('NoAccountHere', false, profiles)).toEqual({
      uuid: offlineUuid('NoAccountHere'),
      name: 'NoAccountHere',
    })
    expect(await identityFor('NoAccountHere', true, profiles)).toBeNull()
    const verified = await identityFor('Steve', true, profiles)
    expect(verified?.uuid).not.toBe(offlineUuid('Steve'))
  })

  test('an identity says which kind of server it was made for', async () => {
    const profiles = new FakeProfiles()
    const account = (await identityFor('Steve', true, profiles)) ?? { uuid: '', name: '' }
    const derived = { uuid: offlineUuid('Steve'), name: 'Steve' }
    expect(keyedFor(account, true)).toBe(true)
    expect(keyedFor(account, false)).toBe(false)
    expect(keyedFor(derived, false)).toBe(true)
    expect(keyedFor(derived, true)).toBe(false)
  })
})
