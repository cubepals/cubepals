// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A deploy judges which Fly apps a change is built into from what their Dockerfiles copy, so every
 * file an image copies redeploys that image's apps: the edge's copy of Minecraft's ports, the
 * control image's brand lockup and bunfig.toml.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { appsFor, flyInputs } from './production-web.ts'

/** Every source path a Dockerfile COPYs from the build context. */
function copied(dockerfile: string): string[] {
  return readFileSync(dockerfile, 'utf8')
    .split('\n')
    .filter((line) => /^COPY\s/.test(line) && !line.includes('--from='))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1))
}

describe('what each Fly app is built from', () => {
  test('every file the edge image copies redeploys the edge', () => {
    const missed = copied('apps/edge/Dockerfile').filter((path) => !appsFor([path]).includes('edge'))
    expect(missed).toEqual([])
  })

  test('every file the control image copies counts as a Fly input', () => {
    const missed = copied('apps/control/Dockerfile').filter((path) => flyInputs([path]).length === 0)
    expect(missed).toEqual([])
  })
})
