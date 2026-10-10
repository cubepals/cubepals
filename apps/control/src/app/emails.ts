/**
 * Cubepals' emails: the one layout every email is built on, and the pieces its words are set in.
 * Each email is its plain text plus an HTML part: the lockup on an Ink tile, a white card with a
 * 2px Ink edge, a heading, the words, one Ink button. A few carry one of the landing's people
 * (brand/figures/), standing on the card's top edge or hanging from it by the hands.
 *
 * Pictures and the font stylesheet load from the web origin each email is given, under /email/
 * (apps/web/public/email/): production's from its own site, staging's from staging, a local
 * stack's from its dev server. The text part is what a test reads links from, and what a mail app
 * that shows no HTML shows.
 *
 * Light only, on purpose. Apple Mail honours `color-scheme: light only`; Gmail's apps and Outlook
 * invert colours whatever the email asks. So nothing may depend on the background staying light:
 * the lockup carries its own Ink tile (a black logo on transparency vanishes when inverted), and
 * every pair of colours still reads when both are flipped.
 *
 * Parts (`emails/`):
 * - `account.ts`: welcome, confirming an email, a reset link and a changed password.
 * - `admins.ts`: what the platform tells every admin: a raised alert, the daily spend limit.
 * - `billing.ts`: a payment carrying extra play that failed, and one still owed after that.
 * - `play.ts`: the warnings as a month's included play runs out, and as extra play is used.
 * - `servers.ts`: what happened to one server: off the directory, an idle world, a rebuild.
 */

export const INK = '#0d0d0d'
const PAPER = '#F8F7F5'
const STONE = '#E6E3DC'
export const MUTED = '#3a3835'
const SUBTLE = '#5b5954'
export const SANS = `'Geologica', system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`
export const MONO = `'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace`

/** An email as it is sent: the subject, the line an inbox shows under it, and both parts. */
export type Email = { subject: string; preheader: string; html: string; text: string }

type Action = { label: string; url: string }
type Chip = { label: string; tone: 'online' | 'sleeping' | 'danger' | 'quiet' }

/**
 * The landing's people the emails show, as `bun brand/figures/figures.ts` writes them to
 * apps/web/public/email/: each image is drawn at twice these CSS pixels, for sharp screens.
 */
const FIGURES = {
  'moss-waving': { file: 'moss-waving.gif', width: 66, height: 105 },
  'worker-clipboard': { file: 'worker-clipboard.png', width: 54, height: 99 },
  'kai-hanging': { file: 'kai-hanging.png', width: 54, height: 111 },
} as const

type FigureName = keyof typeof FIGURES

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const p = (html: string) =>
  `<p style="margin:0 0 16px;font:400 16px/1.55 ${SANS};color:${MUTED}">${html}</p>`

export const small = (html: string) =>
  `<p style="margin:0 0 12px;font:400 14px/1.5 ${SANS};color:${SUBTLE}">${html}</p>`

export const link = (a: Action) =>
  `<a href="${esc(a.url)}" style="color:${INK};text-decoration:underline;text-underline-offset:2px">${esc(a.label)}</a>`

const TONES: Record<Chip['tone'], { fg: string; bg: string }> = {
  online: { fg: '#8A5A00', bg: '#FFE9BD' },
  sleeping: { fg: '#4D47B8', bg: '#ECEBFA' },
  danger: { fg: '#A93325', bg: '#FBEBE7' },
  quiet: { fg: INK, bg: STONE },
}

const chip = (c: Chip) => {
  const t = TONES[c.tone]
  return `<span style="display:inline-block;padding:3px 8px;border:2px solid ${t.fg};background:${t.bg};color:${t.fg};font:700 12px/1.2 ${SANS};letter-spacing:.06em;text-transform:uppercase">${esc(c.label)}</span>`
}

/** The one Ink button; Outlook gets the same box from the table cell. */
const button = (a: Action) => `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr>
  <td style="background:${INK};border:2px solid ${INK}">
    <a href="${esc(a.url)}" style="display:inline-block;padding:13px 22px;font:800 16px/1 ${SANS};color:${PAPER};text-decoration:none">${esc(a.label)}</a>
  </td>
</tr></table>`

/** A box set down on the card: the mod list, the money. */
export const box = (rows: string) =>
  `<div style="margin:0 0 20px;border:2px solid ${INK};background:${PAPER};padding:14px 16px">${rows}</div>`

/** Play as ten blocks, filled to the mark: the meter players already know from the game. */
export const meter = (used: number, included: number) => {
  const filled = Math.min(10, Math.round((used / included) * 10))
  const cells = Array.from(
    { length: 10 },
    (_, i) =>
      `<td style="width:22px;height:22px;padding:0;background:${i < filled ? INK : STONE};border:2px solid ${INK}"></td>`,
  ).join('<td style="width:4px;padding:0"></td>')
  return `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 8px"><tr>${cells}</tr></table>
<p style="margin:0 0 20px;font:700 14px/1.4 ${MONO};color:${INK}">${used} of ${included} hours</p>`
}

/** A figure's picture, from the web origin's /email/. */
const figureImg = (origin: string, name: FigureName) => {
  const f = FIGURES[name]
  return `<img src="${origin}/email/${f.file}" width="${f.width}" height="${f.height}" alt="" style="display:block;border:0;width:${f.width}px;height:${f.height}px">`
}

/** Who an email is for, said under the card with why they get it. */
export const ACCOUNT = 'You get this because you have a Cubepals account.'
export const OWNER = 'You get this because you own this server on Cubepals.'
export const ADMIN = 'You get this because you are a Cubepals admin.'

export function layout(input: {
  /** The web origin the pictures, the font stylesheet and the lockup's link are on. */
  origin: string
  preheader: string
  /** Standing on the card, or with `hang`, hanging inside it from its top edge. */
  figure?: { name: FigureName; hang?: boolean }
  chip?: Chip
  heading: string
  body: string
  action?: Action
  after?: string
  why: string
}): string {
  const { origin } = input
  const stand = input.figure && !input.figure.hang ? input.figure.name : undefined
  const hang = input.figure?.hang ? input.figure.name : undefined
  const lockup = `<a href="${origin}"><img src="${origin}/email/lockup.png" width="160" height="44" alt="cubepals" style="display:block;border:0;background:#0d0d0d"></a>`
  const top = `${input.chip ? `<div style="margin:0 0 14px">${chip(input.chip)}</div>` : ''}
      <h1 style="margin:0 0 16px;font:800 26px/1.2 ${SANS};letter-spacing:-.01em;color:${INK}">${input.heading}</h1>`
  const fallback = input.action
    ? `<p style="margin:0;font:400 13px/1.5 ${SANS};color:${SUBTLE}">If the button doesn’t open, paste this into your browser:<br><span style="font:400 12px/1.5 ${MONO};color:${INK};word-break:break-all">${esc(input.action.url)}</span></p>`
    : ''
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<link href="${origin}/email/fonts.css" rel="stylesheet">
<title>${esc(input.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(input.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}"><tr><td align="center" style="padding:32px 16px 40px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    ${
      stand
        ? `<tr><td style="padding:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="top" style="padding:0 0 20px">${lockup}</td>
      <td align="right" valign="bottom" style="padding:0 28px 0 0;line-height:0;font-size:0">${figureImg(origin, stand)}</td>
    </tr></table></td></tr>`
        : `<tr><td style="padding:0 0 20px">${lockup}</td></tr>`
    }
    <tr><td style="background:#ffffff;border:2px solid ${INK};padding:${hang ? 0 : 32}px 28px 28px">
      ${
        hang
          ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="top" style="padding:32px 16px 0 0">${top}</td>
        <td valign="top" align="right" style="width:${FIGURES[hang].width}px;line-height:0;font-size:0">${figureImg(origin, hang)}</td>
      </tr></table>`
          : top
      }
      ${input.body}
      ${input.action ? button(input.action) : ''}
      ${input.after ?? ''}
      ${fallback}
    </td></tr>
    <tr><td style="padding:20px 2px 0;font:400 13px/1.55 ${SANS};color:${SUBTLE}">
      ${input.why} Reply to this email to reach a person.<br>
      <a href="${origin}" style="color:${SUBTLE}">cubepals.com</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`
}
