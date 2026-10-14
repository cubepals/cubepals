// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { ownIconPath, type ServerIcon } from '@blockly/contracts'

/**
 * A server's picture as every view carries it: the icon picked, by key, and where the owner's own
 * picture is fetched, when that shows instead.
 */
export const pictureOf = (server: {
  id: string
  icon: string | null
  ownIcon: string | null
}): { icon: ServerIcon | null; ownIcon: string | null } => ({
  icon: server.icon as ServerIcon | null,
  ownIcon: server.ownIcon === null ? null : ownIconPath(server.id, server.ownIcon),
})
