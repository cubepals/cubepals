import { describe, expect, test } from 'bun:test'
import { SERVER_STATUSES } from '@blockly/contracts'
import { notNow } from './transitions.ts'

// "A server that is provisioning cannot do that right now" reached owners (end-to-end, 2026-09-27).
describe('why a server cannot do something right now', () => {
  test('is a sentence for every status, never the status’s own name', () => {
    for (const status of SERVER_STATUSES) {
      const said = notNow(status)
      expect(said).toMatch(/^[A-Z].*\.$/)
      if (!['running', 'stopped', 'stopping', 'starting'].includes(status)) expect(said).not.toContain(status)
    }
  })

  test('a server in the trash says so', () => {
    expect(notNow('deleted')).toBe('This server is in the trash. Restore it to use it again.')
  })
})
