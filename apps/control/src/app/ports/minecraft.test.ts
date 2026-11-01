// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Minecraft port failures keep their identity, explanatory message and underlying cause. */
import { expect, test } from 'bun:test'
import { AnswerUnreadable, ClientJarRejected, ConsoleUnavailable } from './minecraft.ts'

for (const Failure of [ConsoleUnavailable, AnswerUnreadable]) {
  test(`${Failure.name} preserves the console or probe failure`, () => {
    const cause = new Error('connection closed')
    const error = new Failure('Could not read the server answer', { cause })
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(Failure)
    expect(error.name).toBe(Failure.name)
    expect(error.message).toBe('Could not read the server answer')
    expect(error.cause).toBe(cause)
  })
}

test('a refused client jar explains the validation failure', () => {
  const error = new ClientJarRejected('checksum mismatch')
  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe('ClientJarRejected')
  expect(error.message).toBe('The client jar was refused: checksum mismatch')
})
