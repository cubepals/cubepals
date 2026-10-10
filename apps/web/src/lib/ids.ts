// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { v4 as uuidv4 } from 'uuid'

/**
 * A random UUID for request ids and idempotency keys. `crypto.randomUUID` exists only in a
 * secure context — https, or localhost — so a page opened at a network address like
 * http://192.168.1.20 has none, and every button that sends a request id would throw.
 *
 * `uuid` has handled that case for years, so it is what fills in: the platform's own generator
 * where there is one, a library everybody uses where there is not.
 */
export function newId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : uuidv4()
}
