// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The colours a note writer's picture is drawn in: the site's own (`ui/tokens.json`, light theme),
 * as plain values because the drawing libraries take colours, not CSS variables. Every picture
 * brings its own sand, so a list of them reads as one family in either theme.
 */

/** The sand every picture is drawn on (`--surface-sand`). */
export const PAPER = '#e6e3dc'

/** Ink (`--ink`): only ever an accent inside a picture of many colours, never a picture's one colour. */
export const INK = '#0d0d0d'

/**
 * The colours a picture's shapes take: the accents and status colours (`--accent`, `--dusk`,
 * `--lake`, `--danger`, `--status-online` in light and dark). Never ink alone: a black mark reads
 * as the Cubepals logo, which is only for Cubepals' own servers.
 */
export const COLOURS = ['#3a2e8f', '#5d56d6', '#8c86f2', '#a93325', '#8a5a00', '#ffb01f'] as const
