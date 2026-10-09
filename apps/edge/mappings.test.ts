import { expect, test } from 'bun:test'
import { mappings } from './mappings.ts'

const NOTICES = { restarting: '127.0.0.1:25564', asleep: '127.0.0.1:25563' }

test('a sleeping server goes to the sleeping notice, never to where it would run', () => {
  const routes = [
    { hostname: 'lobby.play.test', destination: 'bly-a.flycast:25565', state: 'asleep' as const },
    { hostname: 'lobby.blockly.test', destination: 'bly-a.flycast:25565', state: 'asleep' as const },
  ]
  expect(mappings(routes, new Set(['bly-a.flycast:25565']), NOTICES)).toEqual({
    'lobby.play.test': NOTICES.asleep,
    'lobby.blockly.test': NOTICES.asleep,
  })
})

test('a running server goes to itself, or to the restarting notice while it doesn’t answer', () => {
  const routes = [
    { hostname: 'up.play.test', destination: 'bly-a.flycast:25565' },
    { hostname: 'down.play.test', destination: 'bly-b.flycast:25565' },
  ]
  expect(mappings(routes, new Set(['bly-b.flycast:25565']), NOTICES)).toEqual({
    'up.play.test': 'bly-a.flycast:25565',
    'down.play.test': NOTICES.restarting,
  })
})

test('a restarting server goes to the restarting notice', () => {
  const routes = [
    { hostname: 'lobby.play.test', destination: 'bly-a.flycast:25565', state: 'restarting' as const },
  ]
  expect(mappings(routes, new Set(), NOTICES)).toEqual({ 'lobby.play.test': NOTICES.restarting })
})
