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

/** The workflow's first step: whether this run may go on, and the commit it deploys. */
function run(command: string, version: string): void {
  const main = rev('HEAD^{commit}')
  const workflowSha = process.env.WORKFLOW_SHA ?? ''
  if (workflowSha === '') refuse(['WORKFLOW_SHA, the commit this run’s workflow is from, isn’t given.'])
  if (rev(`${workflowSha}:${WORKFLOW}`) !== rev(`${main}:${WORKFLOW}`))
    refuse([
      `This run's workflow, from ${workflowSha.slice(0, 8)}, isn't main's (${main.slice(0, 8)}): an old run started again runs its old steps.`,
      'Start a new run: gh workflow run deploy-production.yml',
    ])
  let commit = main
  if (command === 'apply') {
    const tag =
      version || (git(HERE, 'tag', '--list', '*-nightly.*', '--sort=-v:refname').stdout.split('\n')[0] ?? '')
    if (!isNightly(tag))
      refuse([`"${tag}" isn't a nightly. Production takes only a commit a nightly passed on staging.`])
    commit = rev(`refs/tags/${tag}^{commit}`)
    if (commit === '' || git(HERE, 'merge-base', '--is-ancestor', commit, main).status !== 0)
      refuse([`${tag} (${commit.slice(0, 8) || 'no such tag'}) isn't a commit on main.`])
    say(`Deploying ${tag}, ${commit}.`)
  } else if (command.startsWith('rollback')) say(`Rolling back with main's code, ${main}.`)
  else refuse([`There is no command "${command}".`])
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\n`)
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
  else if (command === 'fits') fits(args[0] ?? '')
  else if (command === 'plan') plan(args[0] ?? '', args[1] ?? '', args[2] ?? '')
  else
    refuse([
      'Usage: bun scripts/production-guard.ts run <command> [version] | fits <commit> | plan <dir> <file> <sha256>',
    ])
}
