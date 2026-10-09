import { describe, expect, test } from 'bun:test'
import { AccessReseedFailed } from './access/reconciler.ts'
import { AppError, DiagnosedFailure, inFull, inPlainWords, ownersWords, PermanentFailure } from './errors.ts'
import { NotReady } from './operations/boot.ts'
import { RuntimeFull } from './ports/runtime.ts'

describe('what owners read about an error', () => {
  test('Blockly’s own words reach them as they are, retried or not', () => {
    expect(inPlainWords(new AppError('invalid_choice', 'That location is not available.'))).toBe(
      'That location is not available.',
    )
    expect(inPlainWords(new PermanentFailure('That backup is no longer there.'))).toBe(
      'That backup is no longer there.',
    )
    expect(inPlainWords(new DiagnosedFailure('It ran out of memory.', 'resize'))).toBe(
      'It ran out of memory.',
    )
    expect(inPlainWords(new NotReady('The server did not finish loading in time.'))).toBe(
      'The server did not finish loading in time.',
    )
    expect(ownersWords(new AccessReseedFailed('the server didn’t take it just then'))).toContain(
      'Could not restore who can join',
    )
  })

  test('a provider with no room is told as that, and anything else as whose side it was on', () => {
    expect(inPlainWords(new RuntimeFull('fly', 'nothing placeable for 4096 MB in fra'))).toBe(
      'There was no room for it where it runs just then. Try again in a few minutes.',
    )
    const raw = new Error('Fly: creating a machine failed with 500: {"error":"internal"}')
    expect(ownersWords(raw)).toBeNull()
    expect(inPlainWords(raw)).toBe('This one was on Cubepals’ side, not yours. Trying again usually works.')
  })

  test('the record keeps everything that was said, causes included', () => {
    const ping = new Error('connect ECONNREFUSED fdaa::3:25565')
    expect(inFull(new NotReady('The server did not finish loading in time.', { cause: ping }))).toBe(
      'The server did not finish loading in time. (connect ECONNREFUSED fdaa::3:25565)',
    )
    expect(inFull('a string thrown')).toBe('a string thrown')
  })
})
