// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How an edge asks for its routes (`edge.ts`), in what the edge's own image carries, which
 * imports nothing.
 *
 * An edge names itself in `EDGE_ID_HEADER` and sends the ETag of the routes it holds, every one
 * applied, as `If-None-Match`. That is its word that it holds them: a server reads as running
 * only once every edge seen lately has given it for a list naming the server running. So an edge
 * sends a list's ETag only once it holds all of that list, and asks again at once after applying
 * a new one.
 */
export const EDGE_ID_HEADER = 'x-edge-id'
