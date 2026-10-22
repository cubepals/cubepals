// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** A `host:port` setting as the listener takes it: an IPv6 host without its brackets. */
export const hostPort = (value: string) => {
  const at = value.lastIndexOf(':')
  return { host: value.slice(0, at).replace(/^\[|\]$/g, ''), port: Number(value.slice(at + 1)) }
}
