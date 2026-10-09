// Generates src/ui/tokens.css from the Blockly design system's tokens.json.
// Run after updating tokens.json: bun run apps/web/scripts/tokens.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Token {
  name: string
  value: string | Record<string, string>
}
interface TypeStyle {
  name: string
  fontSize: string
  lineHeight: string
  fontWeight: number
  letterSpacing?: string
}
interface Tokens {
  color: { tokens: Token[] }
  type: { groups: Array<{ family: 'sans' | 'mono'; styles: TypeStyle[] }> }
  spacing: { tokens: Token[] }
  radius: { tokens: Token[] }
  shadow: { tokens: Token[] }
  layout: { tokens: Token[] }
}

const ui = join(import.meta.dir, '../src/ui')
const tokens = JSON.parse(readFileSync(join(ui, 'tokens.json'), 'utf8')) as Tokens

const themed = [...tokens.color.tokens, ...tokens.shadow.tokens]
const flat = [...tokens.spacing.tokens, ...tokens.radius.tokens, ...tokens.layout.tokens]
const value = (t: Token, theme: 'light' | 'dark') =>
  typeof t.value === 'string' ? t.value : (t.value[theme] ?? t.value.light)
const block = (theme: 'light' | 'dark') => themed.map((t) => `  --${t.name}: ${value(t, theme)};`).join('\n')

const typeClasses = tokens.type.groups
  .flatMap((group) =>
    group.styles.map((s) =>
      [
        `.type-${s.name} {`,
        `  font-family: var(--font-${group.family});`,
        `  font-size: ${s.fontSize};`,
        `  line-height: ${s.lineHeight};`,
        `  font-weight: ${s.fontWeight};`,
        ...(s.letterSpacing ? [`  letter-spacing: ${s.letterSpacing};`] : []),
        ...(s.name === 'eyebrow' ? ['  text-transform: uppercase;'] : []),
        '}',
      ].join('\n'),
    ),
  )
  .join('\n\n')

const css = `/* Generated from tokens.json by apps/web/scripts/tokens.ts. Do not edit by hand. */

:root {
  color-scheme: light;
  --font-sans: var(--font-geologica), var(--font-figtree), system-ui, "Segoe UI", Helvetica, Arial, sans-serif;
  --font-mono: var(--font-plex-mono), ui-monospace, Menlo, Consolas, monospace;
${flat.map((t) => `  --${t.name}: ${value(t, 'light')};`).join('\n')}
${block('light')}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
${block('dark').replace(/^/gm, '  ')}
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
${block('dark')}
}

${typeClasses}
`

writeFileSync(join(ui, 'tokens.css'), css)
console.warn(`Wrote ${themed.length} themed and ${flat.length} flat tokens`)
