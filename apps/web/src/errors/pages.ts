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
  'cloudflare-1xxx.html': { kind: 'unreachable', token: '::CLOUDFLARE_ERROR_1000S_BOX::' },
} as const satisfies Record<string, { kind: LostKind; token: string }>

const STYLE = `
:root{color-scheme:light;--ink:#0d0d0d;--muted:#5b5954;--paper:#f8f7f5}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px 16px;background:var(--paper);color:var(--ink);font:18px/28px system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:34rem;display:flex;flex-direction:column;gap:16px}
img{width:78px;height:auto;image-rendering:pixelated}
h1{margin:0;font-size:36px;line-height:40px;font-weight:800;letter-spacing:-.05em;text-wrap:balance}
p{margin:0}
.fine{color:var(--muted);font-size:16px;line-height:24px}
.row{display:flex;flex-wrap:wrap;gap:12px;margin-block:8px}
.go{display:inline-block;padding:10px 18px;border:2px solid var(--ink);border-radius:8px;color:var(--ink);font-weight:700;text-decoration:none}
.go.first{background:var(--ink);color:var(--paper)}
a{color:inherit;text-underline-offset:.2em}
.mark{font-weight:700;letter-spacing:-.07em}
`

/** One page as a document; `figure` is the picture as a data URI, so the page loads alone. */
export function staticPage(file: keyof typeof STATIC_PAGES, figure: string): string {
  const { kind, token } = STATIC_PAGES[file]
  const copy = LOST[kind]
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${copy.title} · Cubepals</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="mark">cubepals</p>
<img src="${figure}" alt="">
<h1>${copy.title}</h1>
<p>${copy.line}</p>
<p class="fine">${SERVERS_LINE}</p>
<p class="row"><a class="go first" href="?">Try again</a><a class="go" href="https://cubepals.com/">Go home</a></p>
<p class="fine">Still stuck? Write to <a href="mailto:${SUPPORT}">${SUPPORT}</a>. We read every message.</p>${token ? `\n${token}` : ''}
</main>
</body>
</html>
`
}
