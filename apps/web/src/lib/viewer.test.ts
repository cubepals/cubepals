import { describe, expect, test } from 'bun:test'
import { behindSignIn, behindSignUp } from './viewer'

describe('where a link goes for someone who may be signed out', () => {
  test('signing in comes first, then the page they were on', () => {
    expect(behindSignIn(false, '/server/sunset-valley')).toBe('/sign-in?next=%2Fserver%2Fsunset-valley')
    // The path is one parameter, whatever it holds.
    expect(behindSignIn(false, '/browse?tag=survival&kind=modded')).toBe(
      '/sign-in?next=%2Fbrowse%3Ftag%3Dsurvival%26kind%3Dmodded',
    )
  })

  test('someone signed in goes straight there', () => {
    expect(behindSignIn(true, '/server/sunset-valley')).toBe('/server/sunset-valley')
    expect(behindSignUp(true, '/servers/new')).toBe('/servers/new')
  })

  test('a new account comes first where only an account will do', () => {
    expect(behindSignUp(false, '/servers/new?like=sunset-valley')).toBe(
      '/sign-up?next=%2Fservers%2Fnew%3Flike%3Dsunset-valley',
    )
  })
})
