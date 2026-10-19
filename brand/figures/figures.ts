// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The landing's people as the emails show them, written to apps/web/public/email/, where every
 * email loads them from its web origin:
 *
 *     bun brand/figures/figures.ts
 *
 * Run it again rather than editing the pictures. Each is drawn at twice its CSS size; the emails'
 * layout (apps/control/src/app/emails.ts) sets the CSS sizes this prints, and the two must agree.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { clipboard, type Figure, hanging, KAI, MOSS, shrugging, WORKER, waving } from './sprites.ts'

const FIGURES = {
  'moss-waving': waving(MOSS),
  'worker-clipboard': clipboard(WORKER),
  'kai-hanging': hanging(KAI),
} satisfies Record<string, Figure>

/** The error pages' own, which the site serves from apps/web/public/errors/. */
const SHRUGS = {
  'moss-shrugging': shrugging(MOSS),
  'kai-shrugging': shrugging(KAI),
} satisfies Record<string, Figure>

for (const [name, f] of Object.entries(FIGURES)) {
  const file = `${name}.${f.type}`
  writeFileSync(new URL(`../../apps/web/public/email/${file}`, import.meta.url), f.data)
  console.warn(`${file}: ${f.width}×${f.height} CSS px`)
}
mkdirSync(new URL('../../apps/web/public/errors/', import.meta.url), { recursive: true })
for (const [name, f] of Object.entries(SHRUGS)) {
  const file = `${name}.${f.type}`
  writeFileSync(new URL(`../../apps/web/public/errors/${file}`, import.meta.url), f.data)
  console.warn(`${file}: ${f.width}×${f.height} CSS px`)
}
