// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** ChatSentinel's own settings with Cubepals' changes, which its header lists. */
import { readFileSync } from 'node:fs'

export const CHAT_FILTER = readFileSync(new URL('./chatsentinel-config.yml', import.meta.url), 'utf8')
