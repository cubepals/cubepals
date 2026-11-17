// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Offline world progression's Paper plugin and Fabric mod (apps/progression), built from this
 * repository and kept as built jars (`built-jar.ts`). Which servers get which is
 * `progression/progression.ts`'s.
 */
import { fileURLToPath } from 'node:url'
import { BuiltJar } from './built-jar.ts'

const inImage = (name: string) =>
  fileURLToPath(new URL(`../../../assets/progression/${name}`, import.meta.url))

export const PROGRESSION_PLUGIN = new BuiltJar({
  inImage: inImage('cubepals-progression.jar'),
  fileName: 'cubepals-progression.jar',
  projectId: 'progression',
  name: 'CubepalsProgression',
  dir: 'plugins',
  loaders: ['paper'],
  said: 'the progression plugin',
})

export const PROGRESSION_MOD = new BuiltJar({
  inImage: inImage('cubepals-progression-fabric.jar'),
  fileName: 'cubepals-progression-fabric.jar',
  projectId: 'progression-fabric',
  name: 'Cubepals Progression',
  dir: 'mods',
  loaders: ['fabric'],
  said: 'the progression mod',
})

/** Both, for what treats every jar Cubepals builds alike (`service.ts`). */
export const PROGRESSION_JARS: readonly BuiltJar[] = [PROGRESSION_PLUGIN, PROGRESSION_MOD]
