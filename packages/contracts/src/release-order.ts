// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minecraft's releases in order, written once for the control plane and the website: which of two
 * is newer, and whether a version is a release at all. It imports nothing, so the control plane's
 * minecraft/ may use it.
 */

/** Whether a version is a release's (`1.21.11`, `26.3`), not a snapshot's (`24w14a`, `1.21-pre1`). */
export const isRelease = (version: string): boolean => /^\d+(\.\d+){1,2}$/.test(version)

/**
 * Orders release ids: 1.21.8 < 1.21.10 < 26.1.2 < 26.2. Worlds only move forward, so a change
 * to an older release is refused.
 *
 * Written out rather than taken from `compare-versions`, checked 2026-09-23: it imports no
 * packages, and Minecraft's releases are not semantic versions — `26.3` sits beside `1.21.8` — so
 * a library that assumes they are would be right today by accident. The cases that matter are in
 * the control plane's `minecraft.test.ts`.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}
