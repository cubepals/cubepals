// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What may go to production, decided by main rather than by what is going. A nightly runs its own
 * production.ts and its own Terraform, so a check inside it protects only nightlies made after the
 * check. The Deploy production workflow runs this file from main, at the commit main is on when
 * the run starts, before anything is opened or changed (docs/production.md § Deploy from GitHub):
 *
 *   bun <main>/scripts/production-guard.ts run <command> [version]
 *       refuses a run whose workflow isn't main's (an old run started again runs its own steps),
 *       and names the commit it deploys: for apply, the nightly's, which must be on main; for a
 *       rollback, main's own
 *   bun <main>/scripts/production-guard.ts route
 *       refuses an old run started again, as `run` does, and names the road main's newest commit
 *       takes from what production runs (production-route.ts): `route` and `commit` in
 *       GITHUB_OUTPUT, and why in the run's summary. `ship now` follows it
 *   bun <main>/scripts/production-guard.ts run website <commit>
 *       the website route: refuses a commit not on main, one whose change since what production runs
 *       isn't the website's alone, and one without its proof (`proven`)
 *   bun <main>/scripts/production-guard.ts proven <commit>
 *       whether a commit with `commit`'s tree (itself, or its pull request's head) passed CI's `check`
 *       and had its preview answer as CLAUDE.md asks (PREVIEW_PROOF, set by web-staging.yml)
 *   bun <main>/scripts/production-guard.ts fits <commit>
 *       refuses a commit production's settings need something newer of (REQUIREMENTS), or one whose
 *       apply doesn't have its plan reviewed
 *   bun <main>/scripts/production-guard.ts plan <terraform dir> <plan file> <sha256>
 *       reviews the saved plan (production-plan-review.ts) against the stack's `terraform_only` as
 *       main has it; production.ts apply runs it, then applies that same file
 *
 * production.ts uses `missing` too, from its own checkout: a hotfix or rollback that would put an
 * older control plane in place than the settings need is refused for the control app alone.
 *
 * Only node's own modules and files beside it: main's copy runs without an install.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Plan, planProblems, terraformOnly } from './production-plan-review.ts'
import { describeRoute, pathsBetween, routeOf } from './production-route.ts'
import { isNightly } from './versions.ts'

/** The checkout this file is in: main's, in the workflow. Its git sees every commit and tag. */
const HERE = join(import.meta.dir, '..')
const WORKFLOW = '.github/workflows/deploy-production.yml'
const SETTINGS_FILE = 'infra/terraform/environments/production/config.auto.tfvars.json'
/** What a commit whose apply has its plan reviewed before Terraform applies it holds: this file. */
const REVIEWED_APPLY: Marker = { path: 'scripts/production-guard.ts' }

/** A part of production that runs a commit's code: its Terraform, or the control app's image. */
export type Part = 'terraform' | 'control'

/**
 * What a change left in the tree, as production.ts tells an edge image with a drain port: a file,
 * and text in it. Unlike a commit's place in history, it is there in a hotfix branch's cherry-pick
 * and in a shallow clone's one commit.
 */
type Marker = { path: string; text?: string }

/** What production needs of the code it runs, while a setting is set. */
export type Requirement = {
  setting: string
  /** The pull request that made the setting work, and what it left in the tree. */
  change: string
  marker: Marker
  parts: readonly Part[]
  why: string
}

export const REQUIREMENTS: readonly Requirement[] = [
  {
    setting: 'PLAY_IPV4',
    change: '#445',
    // Before it, the stack never names the setting, so it goes to the Fly apps with the rest.
    marker: { path: 'infra/terraform/stack/main.tf', text: '"PLAY_IPV4"' },
    parts: ['terraform'],
    why: "older Terraform points the play names' wildcard back at the edge's anycast address and gives the Fly apps PLAY_IPV4",
  },
  {
    setting: 'PLAY_IPV4_BY_REGION',
    change: '#447',
    marker: { path: 'apps/control/src/app/edge/play-records.ts' },
    parts: ['control'],
    why: "an older control plane stops keeping the play names' own records, which go stale as servers are made, moved and deleted",
  },
]

const git = (repo: string, ...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

/** Whether `commit` has what a change left; false when it isn't a commit this checkout has. */
function has(commit: string, marker: Marker, repo: string): boolean {
  if (!/^[0-9a-f]{40}$/.test(commit)) return false
  const file = git(repo, 'show', `${commit}:${marker.path}`)
  return file.status === 0 && (marker.text === undefined || file.stdout.includes(marker.text))
}

/**
 * The requirements `commit` doesn't meet for these parts while `settings` are what they are. A
 * commit that isn't known here (an image from before deploy labels) meets none.
 */
export function missing(
  commit: string,
  settings: Readonly<Record<string, string>>,
  parts: readonly Part[],
  repo = HERE,
): Requirement[] {
  return REQUIREMENTS.filter(
    (r) =>
      (settings[r.setting] ?? '') !== '' &&
      r.parts.some((part) => parts.includes(part)) &&
      !has(commit, r.marker, repo),
  )
}

/** The lines that say why, one a requirement. */
export const whyNot = (unmet: readonly Requirement[]): string[] =>
  unmet.map((r) => `  ${r.setting} is set, and the code is older than ${r.change}: ${r.why}.`)

const say = (line: string) => process.stdout.write(`${line}\n`)

function refuse(lines: readonly string[]): never {
  for (const line of lines) say(line)
  process.exit(1)
}

const rev = (spec: string) => git(HERE, 'rev-parse', '--verify', '--quiet', spec).stdout.trim()

/** The commit status web-staging.yml sets once a preview answers 200 on the pages and a picture. */
export const PREVIEW_PROOF = 'Website preview answers'

/** GitHub's API through gh, as this run's token reads it; one answer a line. */
function api(path: string, jq: string): string[] {
  const repository = process.env.GITHUB_REPOSITORY ?? 'cubepals/cubepals'
  const answer = spawnSync('gh', ['api', `repos/${repository}/${path}`, '--jq', jq], { encoding: 'utf8' })
  return answer.status === 0 ? answer.stdout.split('\n').filter(Boolean) : []
}

/**
 * The commits GitHub checked that have `commit`'s tree: the commit, and each pull request head it
 * came from with the same tree. A squash merge of a pull request that was up to date with main is
 * the tree its CI and preview already ran, so it needn't wait for main's run.
 */
function sameTree(commit: string): string[] {
  const tree = rev(`${commit}^{tree}`)
  const heads = api(`commits/${commit}/pulls`, '.[].head.sha')
  return [commit, ...heads.filter((head) => api(`git/commits/${head}`, '.tree.sha')[0] === tree)]
}

/** Whether Actions' `check` passed on a commit, and its preview proof is GitHub Actions' own. */
const checked = (sha: string) =>
  api(
    `commits/${sha}/check-runs?check_name=check`,
    '.check_runs[] | select(.app.slug == "github-actions") | .conclusion',
  ).includes('success')
const previewed = (sha: string) =>
  api(
    `commits/${sha}/statuses`,
    `map(select(.context == "${PREVIEW_PROOF}" and .creator.login == "github-actions[bot]"))[0].state`,
  )[0] === 'success'

/** The commit of `commit`'s tree that passed CI and whose preview answered; undefined when none did. */
const proofOf = (commit: string) => sameTree(commit).find((sha) => checked(sha) && previewed(sha))

const onMain = (commit: string, main: string) =>
  commit !== '' && git(HERE, 'merge-base', '--is-ancestor', commit, main).status === 0

/** The website route's commit, refused unless it is the website's alone and proved. */
function website(version: string, main: string): string {
  const commit = rev(`${version}^{commit}`)
  if (!onMain(commit, main)) refuse([`${version || 'No commit'} isn't a commit on main.`])
  const live = rev('refs/remotes/origin/production^{commit}')
  const paths = live === '' ? null : pathsBetween(HERE, live, commit)
  const decision = paths === null ? null : routeOf(paths)
  if (decision?.route !== 'website')
    refuse([
      `${commit.slice(0, 8)} isn't a change to the website alone since what production runs, so it takes another road.`,
      ...(decision ? describeRoute(decision) : []),
    ])
  const proof = proofOf(commit)
  if (proof === undefined)
    refuse([
      `Neither ${commit.slice(0, 8)} nor a pull request head with its tree has passed CI with its preview answering.`,
      `Wait for main's CI and staging's website deploy on it (\`${PREVIEW_PROOF}\`), then run again.`,
    ])
  say(`Deploying the website from ${commit}, proved by CI and the preview on ${proof.slice(0, 8)}.`)
  return commit
}

/** Main's commit, once this run's workflow is main's: an old run started again runs its old steps. */
function mainsRun(): string {
  const main = rev('HEAD^{commit}')
  const workflowSha = process.env.WORKFLOW_SHA ?? ''
  if (workflowSha === '') refuse(['WORKFLOW_SHA, the commit this run’s workflow is from, isn’t given.'])
  if (rev(`${workflowSha}:${WORKFLOW}`) !== rev(`${main}:${WORKFLOW}`))
    refuse([
      `This run's workflow, from ${workflowSha.slice(0, 8)}, isn't main's (${main.slice(0, 8)}): an old run started again runs its old steps.`,
      'Start a new run: gh workflow run deploy-production.yml',
    ])
  return main
}

const output = (lines: string) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines)
}

/** The workflow's first step: whether this run may go on, and the commit it deploys. */
function run(command: string, version: string): void {
  const main = mainsRun()
  let commit = main
  if (command === 'apply') {
    const tag =
      version || (git(HERE, 'tag', '--list', '*-nightly.*', '--sort=-v:refname').stdout.split('\n')[0] ?? '')
    if (!isNightly(tag))
      refuse([`"${tag}" isn't a nightly. Production takes only a commit a nightly passed on staging.`])
    commit = rev(`refs/tags/${tag}^{commit}`)
    if (!onMain(commit, main))
      refuse([`${tag} (${commit.slice(0, 8) || 'no such tag'}) isn't a commit on main.`])
    say(`Deploying ${tag}, ${commit}.`)
  } else if (command === 'website') commit = website(version, main)
  else if (command.startsWith('rollback')) say(`Rolling back with main's code, ${main}.`)
  else refuse([`There is no command "${command}".`])
  output(`commit=${commit}\n`)
}

/**
 * The road main's newest commit takes from what production runs. When the `production` branch
 * can't be read, or git can't compare the two, it is the whole road.
 */
function route(): void {
  const main = mainsRun()
  const live = rev('refs/remotes/origin/production^{commit}')
  const paths = live === '' ? null : pathsBetween(HERE, live, main)
  const decision = paths === null ? { route: 'full' as const, areas: [] } : routeOf(paths)
  const lines =
    paths === null
      ? ['Route: full.', '  What production runs couldn’t be compared with main, so the whole road it is.']
      : describeRoute(decision)
  for (const line of lines) say(line)
  say(`From ${live.slice(0, 8) || 'an unknown commit'} to ${main.slice(0, 8)}.`)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${lines.join('\n')}\n\`\`\`\n`)
  output(`route=${decision.route}\ncommit=${main}\n`)
}

/** Whether `commit` may be applied to production as its settings are now. */
function fits(commit: string): void {
  if (!existsSync(SETTINGS_FILE)) refuse([`There is no ${SETTINGS_FILE} to read production's settings from.`])
  const settings = (JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as { settings?: Record<string, string> })
    .settings
  const unmet = missing(commit, settings ?? {}, ['terraform', 'control'])
  const reviewed = has(commit, REVIEWED_APPLY, HERE)
  if (unmet.length === 0 && reviewed) {
    say(`${commit.slice(0, 8)} has what production's settings need, and has its Terraform plan reviewed.`)
    return
  }
  refuse([
    `${commit.slice(0, 8)} can't go to production:`,
    ...whyNot(unmet),
    ...(reviewed ? [] : ['  its apply doesn’t have its Terraform plan reviewed before it applies it.']),
    'Deploy a newer nightly. To go back, roll back instead: a rollback runs no Terraform.',
  ])
}

/** Reviews the saved plan production.ts is about to apply: that file, by its hash. */
function plan(directory: string, file: string, sha256: string): void {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (hash !== sha256) refuse([`${file} isn't the plan production.ts made (its hash differs).`])
  const shown = spawnSync('terraform', [`-chdir=${directory}`, 'show', '-json', file], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (shown.status !== 0)
    refuse([`terraform show stopped (exit ${shown.status}), so the plan wasn't reviewed.`])
  const ownOnly = terraformOnly(readFileSync(join(HERE, 'infra/terraform/stack/main.tf'), 'utf8'))
  const problems = planProblems(JSON.parse(shown.stdout) as Plan, ownOnly)
  if (problems.length > 0)
    refuse(['The plan changes what it mustn’t, so nothing was applied:', ...problems.map((p) => `  ${p}`)])
  say("The plan points no play name's wildcard elsewhere and gives the Fly apps nothing of Terraform's own.")
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'run') run(args[0] ?? '', args[1] ?? '')
  else if (command === 'route') route()
  else if (command === 'proven') {
    const proof = proofOf(rev(`${args[0] ?? ''}^{commit}`))
    if (proof === undefined)
      refuse([`${args[0] ?? ''} isn't proved yet: no CI pass with its preview answering.`])
    say(`Proved by CI and the preview on ${proof}.`)
  } else if (command === 'fits') fits(args[0] ?? '')
  else if (command === 'plan') plan(args[0] ?? '', args[1] ?? '', args[2] ?? '')
  else
    refuse([
      'Usage: bun scripts/production-guard.ts run <command> [version] | route | proven <commit> | fits <commit> | plan <dir> <file> <sha256>',
    ])
}
