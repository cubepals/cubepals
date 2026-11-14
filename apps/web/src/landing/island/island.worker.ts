// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Where the island is drawn (scene.ts), off the page's own thread: building the chunk, stepping
 * the friends and printing each frame never holds up a scroll, a tap or a key. This is only the
 * worker's entry, handing serve.ts the worker's own global and the real drawing; what it does for
 * the page is there.
 */
import { Island } from './scene'
import { type Scope, serve } from './serve'

serve(self as unknown as Scope, (canvas) => new Island(canvas))
