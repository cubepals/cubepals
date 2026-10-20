// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The three standalone pages shown when Next can't be, written to public/errors/ by
 * `bun apps/web/scripts/error-pages.ts` (pages.test.ts holds the files to it): what the Worker
 * answers 503 with when it throws (lib/fallback.ts), and the two Cloudflare puts in place of its
 * own 5xx and 1xxx screens (custom pages, set once in the zone). Each is one file with its styles
 * and picture inline, so nothing it shows depends on the site working. Not the React pages
 * (ui/lost.tsx), which Next renders.
 */
import { LOST, type LostKind, SERVERS_LINE, SUPPORT } from './copy'

export const STATIC_PAGES = {
  'unavailable.html': { kind: 'unavailable', token: '' },
  'cloudflare-5xx.html': { kind: 'unreachable', token: '::CLOUDFLARE_ERROR_500S_BOX::' },
  // 1xxx is Cloudflare unable to route to us (DNS or configuration), which may touch the game
  // addresses too, so this page doesn't promise they work.
  'cloudflare-1xxx.html': { kind: 'misrouted', token: '::CLOUDFLARE_ERROR_1000S_BOX::' },
} as const satisfies Record<string, { kind: LostKind; token: string }>

/** The pages that say game servers should keep working: not when the site's own address is what failed. */
const SAYS_SERVERS = new Set<LostKind>(['unavailable', 'unreachable'])

const STYLE = `
:root{color-scheme:light;--ink:#0d0d0d;--muted:#5b5954;--paper:#f8f7f5}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;background:var(--paper);color:var(--ink);font:18px/28px system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:34rem;display:flex;flex-direction:column;gap:16px}
img{width:78px;height:auto;image-rendering:pixelated}
.logo{display:block;align-self:flex-start;width:auto;height:28px;margin-bottom:8px}
.box{margin-top:8px;font-size:13px;line-height:20px;color:var(--muted);overflow-wrap:anywhere}
h1{margin:0;font-size:36px;line-height:40px;font-weight:800;letter-spacing:-.05em;text-wrap:balance}
p{margin:0}
.fine{color:var(--muted);font-size:16px;line-height:24px}
.row{display:flex;flex-wrap:wrap;gap:12px;margin-block:8px}
.row{padding-bottom:3px}
.go{display:inline-flex;align-items:center;justify-content:center;height:44px;padding:0 20px;border:2px solid var(--ink);border-radius:0;background:#fff;box-shadow:0 3px 0 0 color-mix(in srgb,var(--ink) 38%,var(--paper));color:var(--ink);font-size:15px;line-height:20px;font-weight:700;letter-spacing:-.02em;text-decoration:none;white-space:nowrap}
.go.first{background:var(--ink);border-color:var(--paper);color:var(--paper)}
.go:active{translate:0 3px;box-shadow:none}
a{color:inherit;text-underline-offset:.2em}
`

/** The lockup as the pages carry it: classed for their styles, and titled, inside its own `<svg>` tag. */
export const logo = (lockup: string): string =>
  lockup.replace(/<svg\b([^>]*)>/, '<svg class="logo"$1><title>Cubepals</title>')

/** What a page carries inline, so it loads alone: the figure and the icon as data URIs, and the lockup's SVG. */
export interface Inline {
  /** The 404's own figure, public/errors/moss-shrugging.png, as a data URI. */
  figure: string
  /** brand/lockup-horizontal.svg. */
  lockup: string
  /** brand/favicon.svg, the mark, as a data URI. */
  icon: string
}

/** One page as a document. The system font stays: a web font would be a request, which these pages can't depend on. */
export function staticPage(file: keyof typeof STATIC_PAGES, { figure, lockup, icon }: Inline): string {
  const { kind, token } = STATIC_PAGES[file]
  const copy = LOST[kind]
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="${icon}">
<title>${copy.title} · Cubepals</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${logo(lockup)}
<img src="${figure}" alt="">
<h1>${copy.title}</h1>
<p>${copy.line}</p>
${SAYS_SERVERS.has(kind) ? `<p class="fine">${SERVERS_LINE}</p>\n` : ''}
<p class="row"><a class="go first" href="?">Try again</a><a class="go" href="https://cubepals.com/">Go home</a></p>
<p class="fine">Still stuck? Write to <a href="mailto:${SUPPORT}">${SUPPORT}</a>. We read every message.</p>${token ? `\n<div class="box">${token}</div>` : ''}
</main>
</body>
</html>
`
}
