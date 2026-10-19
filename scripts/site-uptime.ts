// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `bun scripts/site-uptime.ts`: what .github/workflows/site-uptime.yml runs every few minutes, from
 * GitHub's machines and not anyone's laptop.
 *
 * It asks for cubepals.com's pages and for hq. and rt.cubepals.com (lib/site-pages.ts). One failure
 * may be a blip, so a failing ask is repeated half a minute later; two in a row are an outage. Then:
 *
 * - if the website's pages are failing, a tail of the `blockly-web` Worker is read for the exception
 *   (best effort), and the Worker is put back on the version live before the current one, once per
 *   outage, and asked again;
 * - one issue, "cubepals.com is down", is opened (or commented on when something changed): which
 *   addresses fail with what status, the exception, and what was rolled back to;
 * - when everything answers again the issue gets a comment and is closed.
 *
 * Needs CLOUDFLARE_WORKERS_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (the same secrets the staging deploys
 * use) for the rollback and the tail; without them the issue says so and nothing is rolled back.
 * GH_TOKEN, REPO and RUN_URL come from the workflow. Prints no token.
 */
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { SECOND_MS } from '@blockly/contracts/durations'
import {
  type Answer,
  ask,
  describe,
  isUp,
  PRODUCTION_OTHERS,
  type Target,
  waitFor,
  websiteTargets,
} from './lib/site-pages.ts'
import { liveVersions, rollbackWorker, type WorkerAccess } from './lib/web-worker.ts'

const TITLE = 'cubepals.com is down'
const ASSIGNEE = 'v0id-user'
const BIN = join(import.meta.dir, '../node_modules/.bin')
/** Appears in a comment so the next run can tell whether anything changed since. */
const MARK = /<!-- failing: (.*) -->/

const say = (line: string) => process.stdout.write(`${line}\n`)

const gh = (args: string[]) => {
  const result = spawnSync('gh', args, { encoding: 'utf8', env: process.env })
  if (result.status !== 0) throw new Error(`gh ${args[0]} ${args[1]}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

/** The open issue, if there is one. */
function openIssue(): number | undefined {
  const found = JSON.parse(
    gh(['issue', 'list', '--state', 'open', '--search', `"${TITLE}" in:title`, '--json', 'number,title']),
  ) as { number: number; title: string }[]
  return found.find((issue) => issue.title === TITLE)?.number
}

/** The failing names last written into the issue's newest comment (or its body). */
function lastMark(number: number): string | undefined {
  const issue = JSON.parse(gh(['issue', 'view', String(number), '--json', 'body,comments'])) as {
    body: string
    comments: { body: string }[]
  }
  for (const text of [...issue.comments.map((c) => c.body).reverse(), issue.body]) {
    const mark = MARK.exec(text)?.[1]
    if (mark !== undefined) return mark
  }
  return undefined
}

/** The exceptions a Worker tail prints, from its JSON lines: names and messages, once each. */
export function tailExceptions(output: string): string[] {
  const found = new Set<string>()
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line) as { exceptions?: { name?: string; message?: string }[] }
      for (const e of event.exceptions ?? [])
        found.add(`${e.name ?? 'Error'}: ${e.message ?? ''}`.slice(0, 400))
    } catch {}
  }
  return [...found]
}

/** Asks for the pages while `wrangler tail blockly-web` listens, and returns what it heard. */
async function readException(access: WorkerAccess, targets: Target[]) {
  const tail = spawn(join(BIN, 'wrangler'), ['tail', 'blockly-web', '--format', 'json'], {
    env: wranglerEnv(access),
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let output = ''
  tail.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  await Bun.sleep(8 * SECOND_MS)
  await ask(targets)
  await Bun.sleep(4 * SECOND_MS)
  tail.kill()
  return tailExceptions(output)
}

const wranglerEnv = (access: WorkerAccess) => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  CLOUDFLARE_API_TOKEN: access.cloudflare.token,
  CLOUDFLARE_ACCOUNT_ID: access.cloudflare.accountId,
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_HIDE_BANNER: 'true',
})

const table = (answers: Answer[]) =>
  answers
    .map(
      (a) =>
        `| ${a.target.name} | ${a.status === 0 ? `no answer (${a.error})` : a.status} | ${a.target.want} | ${isUp(a) ? 'ok' : '**failing**'} |`,
    )
    .join('\n')

function recovered(number: number, answers: Answer[]): void {
  const body = `cubepals.com answers again (${new Date().toISOString()}).\n\n| Address | Status | Wanted | |\n|---|---|---|---|\n${table(answers)}\n\nIf the Worker was rolled back above, that version is still live and the change that broke the site is still on main: fix it before the next deploy.\n\n${process.env.RUN_URL ?? ''}`
  gh(['issue', 'comment', String(number), '--body', body])
  gh(['issue', 'close', String(number), '--reason', 'completed'])
  say(`Closed issue #${number}.`)
}

/** Asked twice, half a minute apart; what the second ask found, or undefined when the first was fine. */
async function confirm(targets: Target[]): Promise<Answer[] | undefined> {
  let answers = await ask(targets)
  if (answers.every(isUp)) return undefined
  say(
    `Failing: ${answers
      .filter((a) => !isUp(a))
      .map(describe)
      .join(', ')}. Asking again in 30 seconds.`,
  )
  await Bun.sleep(30 * SECOND_MS)
  answers = await ask(targets)
  return answers
}

/** The Worker's exception, if the tail hears one. */
async function exceptionNote(access: WorkerAccess, website: Target[]): Promise<string> {
  try {
    const exceptions = await readException(access, website)
    return exceptions.length > 0
      ? `Worker exception from \`wrangler tail\`:\n\n\`\`\`\n${exceptions.join('\n')}\n\`\`\``
      : 'No Worker exception was heard on `wrangler tail` (the Worker may not be throwing, or the token cannot tail).'
  } catch (error) {
    return `\`wrangler tail\` failed: ${(error as Error).message}`
  }
}

/** The Worker put back one version, and the pages asked again; what happened, in lines. */
async function rollBack(access: WorkerAccess, website: Target[]): Promise<string[]> {
  try {
    const [current, previous] = liveVersions(access)
    if (previous === undefined) return ['No earlier version to roll back to.']
    rollbackWorker(access, previous, say)
    const after = await waitFor(website, 60, say)
    return [
      `Rolled \`blockly-web\` back from ${current?.commit?.slice(0, 8) ?? current?.version} to ${previous.commit?.slice(0, 8) ?? 'an earlier commit'} (version \`${previous.version}\`).`,
      after.failing.length === 0
        ? 'After the rollback the pages answer.'
        : `After the rollback still failing: ${after.failing.map(describe).join(', ')}.`,
    ]
  } catch (error) {
    return [`The rollback failed: ${(error as Error).message}`]
  }
}

/** What was done about a confirmed outage of the website's pages, as lines for the issue. */
async function respond(
  access: WorkerAccess | undefined,
  website: Target[],
  existing?: number,
): Promise<string[]> {
  if (!access)
    return [
      'No rollback: CLOUDFLARE_WORKERS_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is not set for this workflow.',
    ]
  const notes = [await exceptionNote(access, website)]
  // One rollback an outage: a second would swing back to the version that was rolled away from.
  if (existing !== undefined)
    return [...notes, 'Already rolled back earlier in this outage; not rolling back again.']
  return [...notes, ...(await rollBack(access, website))]
}

function report(answers: Answer[], notes: string[], existing: number | undefined): void {
  const mark = answers
    .filter((a) => !isUp(a))
    .map((a) => a.target.name)
    .join(',')
  const body = `${new Date().toISOString()}: two asks in a row, half a minute apart, found these failing.\n\n| Address | Status | Wanted | |\n|---|---|---|---|\n${table(answers)}\n\n${notes.join('\n\n')}\n\nRun: ${process.env.RUN_URL ?? ''}\n\n<!-- failing: ${mark} -->`
  if (existing === undefined) {
    say(`Opened ${gh(['issue', 'create', '--title', TITLE, '--assignee', ASSIGNEE, '--body', body])}.`)
  } else if (lastMark(existing) !== mark || notes.some((n) => n.startsWith('Rolled'))) {
    gh(['issue', 'comment', String(existing), '--body', body])
    say(`Commented on issue #${existing}.`)
  } else {
    say(`Issue #${existing} already says this.`)
  }
}

async function main(): Promise<void> {
  const website = websiteTargets('https://cubepals.com')
  const targets = [...website, ...PRODUCTION_OTHERS]
  const existing = openIssue()
  const answers = await confirm(targets)
  const failing = answers?.filter((a) => !isUp(a)) ?? []
  if (answers === undefined || failing.length === 0) {
    say('Up: nothing to report.')
    if (existing !== undefined) recovered(existing, answers ?? (await ask(targets)))
    return
  }
  const token = process.env.CLOUDFLARE_WORKERS_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const access: WorkerAccess | undefined =
    token && accountId ? { cloudflare: { token, accountId } } : undefined
  const webFailing = failing.some((a) => website.includes(a.target))
  const notes = webFailing ? await respond(access, website, existing) : []
  report(answers, notes, existing)
  // Red, so GitHub emails too.
  process.exit(1)
}

if (import.meta.main) await main()
