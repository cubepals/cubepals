/**
 * The landing's people as the emails show them, written to apps/web/public/email/, where every
 * email loads them from its web origin:
 *
 *     bun brand/figures/figures.ts
 *
 * Run it again rather than editing the pictures. Each is drawn at twice its CSS size; the emails'
 * layout (apps/control/src/app/emails.ts) sets the CSS sizes this prints, and the two must agree.
 */
import { writeFileSync } from 'node:fs'
import { clipboard, type Figure, hanging, KAI, MOSS, WORKER, waving } from './sprites.ts'

const FIGURES = {
  'moss-waving': waving(MOSS),
  'worker-clipboard': clipboard(WORKER),
  'kai-hanging': hanging(KAI),
} satisfies Record<string, Figure>

for (const [name, f] of Object.entries(FIGURES)) {
  const file = `${name}.${f.type}`
  writeFileSync(new URL(`../../apps/web/public/email/${file}`, import.meta.url), f.data)
  console.warn(`${file}: ${f.width}×${f.height} CSS px`)
}
