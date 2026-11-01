// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When an owner's change that restarts a running server takes effect while players are on it:
 * `empty` keeps the change waiting until everyone has left, `now` restarts the server at once,
 * after warning the players in the game. With nobody on, either applies at once.
 */
import { z } from 'zod'

export const RESTART_WHEN = ['empty', 'now'] as const
export type RestartWhen = (typeof RESTART_WHEN)[number]
export const RestartWhen = z.enum(RESTART_WHEN)
