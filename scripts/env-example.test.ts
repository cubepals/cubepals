// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

// `.env`, copied from `.env.example`, is read three ways: node's --env-file (the control plane),
// docker compose, and a shell's `source .env` (scripts that read it by hand). They agree on every
// value, so whichever reads it gets the same settings.
test('a shell sources .env.example to the values node reads from it', () => {
  const path = new URL('../.env.example', import.meta.url).pathname
  const node = parseEnv(readFileSync(path, 'utf8'))
  const sourced = spawnSync('bash', ['-c', 'set -a; source "$0" && env -0', path], {
    encoding: 'utf8',
    env: {},
  })
  expect(sourced.stderr).toBe('')
  expect(sourced.status).toBe(0)
  const shell = Object.fromEntries(
    sourced.stdout
      .split('\0')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
  for (const [key, value] of Object.entries(node)) expect({ key, value: shell[key] }).toEqual({ key, value })
})
