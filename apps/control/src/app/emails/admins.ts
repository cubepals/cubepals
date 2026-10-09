/**
 * What the platform tells every admin by email: an alert it raised (platform/alerts.ts), and a day
 * whose spend passed the daily limit (operations/schedules/spend.ts).
 */
import { dollars } from '../../domain/policy/spend.ts'
import { ADMIN, box, type Email, esc, INK, layout, MONO, MUTED, p, SANS, small } from '../emails.ts'

export function adminAlert(input: { summary: string; path: string; origin: string }): Email {
  const url = `${input.origin}${input.path}`
  return {
    subject: `Cubepals needs an admin: ${input.summary}`,
    preheader: 'This is the only email about it.',
    text: `${input.summary}\n\nDeal with it here: ${url}\n\nThis is the only email about it. The alert clears itself once the condition passes, and a new email goes out if it comes back.`,
    html: layout({
      origin: input.origin,
      preheader: 'This is the only email about it.',
      chip: { label: 'Needs an admin', tone: 'danger' },
      heading: esc(input.summary),
      body: '',
      action: { label: 'Deal with it', url },
      after: small(
        'This is the only email about it. The alert clears itself once the condition passes, and a new email goes out if it comes back.',
      ),
      why: ADMIN,
    }),
  }
}

export function spendLimit(input: {
  cents: number
  limitCents: number
  day: string
  computeCents: number
  strayCents: number
  strayMachines: number
  storageCents: number
  origin: string
}): Email {
  const summary = `Cubepals spent ${dollars(input.cents)} today (${input.day}, UTC), past its ${dollars(input.limitCents)} daily limit.`
  const url = `${input.origin}/admin/platform`
  const row = (label: string, value: string) =>
    `<tr><td style="padding:4px 0;font:400 15px/1.4 ${SANS};color:${MUTED}">${label}</td><td align="right" style="padding:4px 0;font:700 15px/1.4 ${MONO};color:${INK}">${value}</td></tr>`
  return {
    subject: summary,
    preheader: 'Starting and creating servers are now off.',
    text: [
      summary,
      '',
      'Starting and creating servers are now off. Servers already running keep running until they idle out.',
      `Compute ${dollars(input.computeCents)}, compute no server accounts for ${dollars(input.strayCents)} (${input.strayMachines} machines), disks ${dollars(input.storageCents)}.`,
      '',
      `Turn them back on, or raise the limit, here: ${url}`,
      "Check Fly's own figure on the organization's billing page before you do (docs/money-guards.md).",
    ].join('\n'),
    html: layout({
      origin: input.origin,
      preheader: 'Starting and creating servers are now off.',
      chip: { label: 'Spend limit', tone: 'danger' },
      heading: `Spent ${dollars(input.cents)} today, past the ${dollars(input.limitCents)} limit`,
      body:
        p(
          `Starting and creating servers are now off. Servers already running keep running until they idle out. (${esc(input.day)}, UTC)`,
        ) +
        box(
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${row('Compute', dollars(input.computeCents))}${row(`Machines no server accounts for (${input.strayMachines})`, dollars(input.strayCents))}${row('Disks', dollars(input.storageCents))}<tr><td colspan="2" style="border-top:2px solid ${INK};padding:0"></td></tr>${row(`<strong style="color:${INK}">Today</strong>`, dollars(input.cents))}</table>`,
        ),
      action: { label: 'Turn back on or raise the limit', url },
      after: small("Check Fly's own figure on the organization's billing page before you do."),
      why: ADMIN,
    }),
  }
}
