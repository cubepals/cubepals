// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Production, from nothing (docs/production.md). Every secret and account value lives in one file
 * the operator keeps, local/production/production.env, and every decided one in the environment's
 * config.auto.tfvars.json, made from the committed example beside it. Nothing commits either.
 *
 *   bun scripts/production.ts init    writes that file: each value with where to get it, the random
 *                                     ones already made. Run again, it keeps what is there
 *   bun scripts/production.ts check   says which values are missing or wrong, and starts the control
 *                                     plane's own configuration check on them, as a machine will
 *   bun scripts/production.ts apply   check, the website built from this checkout, then Terraform
 *                                     (it shows the plan and asks), then the control, realtime and
 *                                     edge apps deployed from this checkout, then this commit pushed
 *                                     as the `production` branch, the website deployed, and the
 *                                     commit released as the next vX.Y.Z (versions.ts).
 *                                     Only a commit a nightly passed on staging goes, unless
 *                                     --without-staging says otherwise. The first time, it stops
 *                                     after making the archive and dumps buckets, so their tokens can
 *                                     be made for them. After Terraform, it gives the Database dump
 *                                     workflow its secrets, in the repository's `production` environment
 *   bun scripts/production.ts web     main's commit built as the website, pushed as the `production`
 *                                     branch and deployed, when neither Terraform nor anything the
 *                                     Fly apps are built from changed since the last deploy and
 *                                     main's CI passed on it: no staging pass, no Fly deploy
 *                                     (production-web.ts says which paths are which)
 *   bun scripts/production.ts hotfix  this commit, once CI passed on it, without a staging pass:
 *                                     only the Fly apps it is built into, the website if it
 *                                     reaches it, then a check that production answers. Never
 *                                     Terraform. From main, or from a branch made from
 *                                     `production` with only the fix on it
 *   bun scripts/production.ts rollback [fly|website]
 *                                     each Fly app back to the image it ran before, and the
 *                                     website back to the version that was live before
 *
 * The `production` branch names what is live, so it is moved, not merged: a push here may move
 * it past a hotfix branch's commit. The website is the Cloudflare Worker `blockly-web`, built here
 * with production's values and deployed with wrangler (production-website.ts, lib/web-worker.ts).
 *
 * Needs terraform, flyctl and gh. Nothing here prints a value, only names.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { authWorks } from './lib/auth-through-website.ts'
import { buildWorker, deployWorker } from './lib/web-worker.ts'
import {
  backendConfig,
  DUMPS_BUCKET,
  DUMPS_ENVIRONMENT,
  dumpSecrets,
  ENVIRONMENT_DIR,
  ENVIRONMENT_EXAMPLE,
  ENVIRONMENT_FILE,
  environment,
  parseValues,
  problemsOf,
  terraformEnv,
  VALUES_FILE,
  valuesFile,
} from './production-values.ts'
import { appsFor, type FlyApp, flyInputs, reachesWebsite, terraformIn } from './production-web.ts'
import { productionSite, rollbackWebsite } from './production-website.ts'
import { isNightly, nextVersion, repositoryTags } from './versions.ts'

const say = (line: string) => process.stdout.write(`${line}\n`)

function read(): Record<string, string> {
  if (!existsSync(ENVIRONMENT_FILE)) {
    say(`There is no ${ENVIRONMENT_FILE} yet. Copy ${ENVIRONMENT_EXAMPLE} to it and put in your own values.`)
    process.exit(1)
  }
  if (!existsSync(VALUES_FILE)) {
    say(`There is no ${VALUES_FILE} yet. Run: bun scripts/production.ts init`)
    process.exit(1)
  }
  return parseValues(readFileSync(VALUES_FILE, 'utf8'))
}

function init(): void {
  const existing = existsSync(VALUES_FILE) ? parseValues(readFileSync(VALUES_FILE, 'utf8')) : {}
  mkdirSync(dirname(VALUES_FILE), { recursive: true })
  writeFileSync(VALUES_FILE, valuesFile(existing), { mode: 0o600 })
  chmodSync(VALUES_FILE, 0o600)
  say(`Wrote ${VALUES_FILE}, with the random values made. Fill in the empty ones, then run check.`)
}

/** True when an apply may go on: with every value, or with all but the buckets' tokens. */
function check(values: Record<string, string>): boolean {
  const { missing, wrong, bucketFirst } = problemsOf(values)
  if (missing.length === 0 && wrong.length === 0) {
    say('Every value is there, and the control plane starts with them.')
    return true
  }
  if (wrong.length > 0) {
    say('To fix:')
    for (const line of wrong) say(`  ${line}`)
  }
  if (missing.length > 0) {
    say(bucketFirst ? 'Only the buckets’ tokens are left, which apply makes room for:' : 'To fill in:')
    for (const value of missing) say(`  ${value.name}: ${value.where}`)
  }
  return wrong.length === 0 && bucketFirst
}

/** Runs a tool, stopping the apply if it fails. `input`, a secret's value, goes to its standard input. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv, input?: string): void {
  const result = spawnSync(command, args, {
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    input,
    env,
  })
  if (result.error) throw new Error(`${command}: ${result.error.message}. Is it installed?`)
  if (result.status !== 0) {
    say(`${command} ${args[0]} stopped (exit ${result.status}). Fix what it says, then run apply again.`)
    process.exit(1)
  }
}

const git = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' }).stdout.trim()

/**
 * The environment flyctl and Terraform run in: production's. Inherited Fly credentials would win
 * over production's, and a shell set up for staging has staging's.
 */
function productionEnv(values: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...terraformEnv(values) }
  delete env.FLY_ACCESS_TOKEN
  return env
}

const DOCKERFILES: Record<FlyApp, string> = {
  control: 'apps/control/Dockerfile',
  realtime: 'apps/control/Dockerfile',
  edge: 'apps/edge/Dockerfile',
}

/**
 * One Fly app deployed from this checkout, or from an image a release of it already ran (a
 * rollback). One machine a role, as FLY_PLATFORM_MACHINES counts them; a second machine each comes
 * once a blip matters.
 */
function deployApp(app: FlyApp, env: NodeJS.ProcessEnv, image?: string): void {
  const source = image ? ['--image', image] : ['.', '--dockerfile', DOCKERFILES[app], '--remote-only']
  const config = ['--config', `infra/fly/${app}.toml`, '--app', `bly-prod-${app}`]
  run('fly', ['deploy', ...source, ...config, '--yes', '--ha=false'], env)
}

/** This commit as the `production` branch, which names what is live, wherever it was before. */
function moveProduction(env: NodeJS.ProcessEnv): void {
  git('fetch', '--quiet', 'origin', 'production')
  const live = git('rev-parse', 'origin/production')
  run('git', ['push', `--force-with-lease=production:${live}`, 'origin', 'HEAD:production'], env)
}

/** Whether CI passed on a commit, on main or on the pull request that carries it. */
function ciPassed(sha: string): boolean {
  const ci = spawnSync(
    'gh',
    ['run', 'list', '--workflow', 'CI', '--commit', sha, '--json', 'conclusion', '-q', '.[0].conclusion'],
    { encoding: 'utf8' },
  )
  return ci.stdout.trim() === 'success'
}

/** What differs between the live commit and this one, as paths. */
function changedSinceLive(): string[] {
  git('fetch', '--quiet', 'origin', 'production')
  return git('diff', '--name-only', 'origin/production', 'HEAD').split('\n').filter(Boolean)
}

function requireClean(): void {
  if (git('status', '--porcelain') !== '') {
    say('This checkout has changes that aren’t committed. Production deploys a commit: commit or stash them.')
    process.exit(1)
  }
}

/**
 * The Database dump workflow's secrets, in the repository's `production` environment. Only `main`'s
 * workflows reach them, and the `production` branch's; a branch's never do.
 */
function setDumpSecrets(values: Record<string, string>, env: NodeJS.ProcessEnv): void {
  const repository = environment().web.repository
  const api = `repos/${repository}/environments/${DUMPS_ENVIRONMENT}`
  const policy = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }
  run('gh', ['api', '--silent', '-X', 'PUT', api, '--input', '-'], env, JSON.stringify(policy))
  const policies = `${api}/deployment-branch-policies`
  const listed = spawnSync('gh', ['api', policies, '--jq', '.branch_policies[].name'], {
    encoding: 'utf8',
    env,
  })
  for (const branch of ['main', 'production'].filter((name) => !listed.stdout.split('\n').includes(name)))
    run('gh', ['api', '--silent', '-X', 'POST', policies, '-f', `name=${branch}`], env)
  for (const [name, value] of Object.entries(dumpSecrets(values)))
    run('gh', ['secret', 'set', name, '--env', DUMPS_ENVIRONMENT, '--repo', repository], env, value)
  say(`The Database dump workflow has its secrets, and dumps into ${DUMPS_BUCKET} every night.`)
}

/** The nightly that ran this commit on staging and passed, if one did (nightly.yml tags them). */
function stagingPass(): string | undefined {
  git('fetch', '--tags', '--quiet', 'origin')
  return git('tag', '--points-at', 'HEAD').split('\n').find(isNightly)
}

async function apply(): Promise<void> {
  const values = read()
  if (!check(values)) process.exit(1)
  if (git('status', '--porcelain') !== '') {
    say('This checkout has changes that aren’t committed. Production deploys a commit: commit or stash them.')
    process.exit(1)
  }
  const passed = stagingPass()
  if (passed === undefined && !process.argv.includes('--without-staging')) {
    say('No nightly has run this commit on staging. Deploy one that did (git tag --list "*-nightly.*"),')
    say('run the Nightly workflow on it, or, to skip staging this once, add --without-staging.')
    process.exit(1)
  }
  const { missing, bucketFirst } = problemsOf(values)

  const env = productionEnv(values)
  const backend = resolve(dirname(VALUES_FILE), 'backend.hcl')
  writeFileSync(backend, backendConfig(values.CLOUDFLARE_ACCOUNT_ID ?? ''))
  const terraform = (...args: string[]) => run('terraform', [`-chdir=${ENVIRONMENT_DIR}`, ...args], env)
  terraform('init', '-input=false', `-backend-config=${backend}`)

  if (bucketFirst) {
    terraform(
      'apply',
      '-input=false',
      '-target=module.environment.module.archive',
      '-target=module.database_dumps',
    )
    say('')
    say(
      `The buckets, ${environment().settings.ARCHIVE_S3_BUCKET} and ${DUMPS_BUCKET}, are made. Now make their tokens and put them in the file:`,
    )
    for (const value of missing) say(`  ${value.name}: ${value.where}`)
    say('Then run apply again.')
    return
  }

  // Built before anything changes, so a build that fails stops the apply here.
  const site = productionSite(values, environment())
  const head = git('rev-parse', 'HEAD')
  buildWorker(site, head, say)
  terraform('apply', '-input=false')
  setDumpSecrets(values, env)
  // The control app first: its release runs the migrations.
  for (const app of ['control', 'realtime', 'edge'] as const) deployApp(app, env)
  moveProduction(env)
  deployWorker(site, head, say)
  await signInGuard()
  const version = `v${nextVersion(repositoryTags())}`
  const notes = passed ? `Ran on staging as ${passed}.` : 'Deployed without a staging run.'
  run(
    'gh',
    ['release', 'create', version, '--target', head, '--latest', '--generate-notes', '--notes', notes],
    env,
  )
  say('')
  say(`Production is ${version}.`)
  say('Check it as docs/production.md § Check it says.')
}

/** The website alone to production: main's commit, when only the website changed since the last deploy. */
async function web(): Promise<void> {
  const values = read()
  requireClean()
  git('fetch', '--quiet', 'origin', 'main')
  const head = git('rev-parse', 'HEAD')
  if (head !== git('rev-parse', 'origin/main')) {
    say('Only main’s latest commit goes to production. Check out main and pull it.')
    process.exit(1)
  }
  const changed = changedSinceLive()
  // What the website deploys into (its Worker, cache bucket and routes) is Terraform's.
  const terraform = terraformIn(changed)
  if (terraform.length > 0) {
    say(`Since the last deploy, Terraform changed too (${terraform.slice(0, 3).join(', ')}): run apply.`)
    process.exit(1)
  }
  const fly = flyInputs(changed)
  if (fly.length > 0) {
    say(
      `Since the last deploy, what the Fly apps are built from changed too (${fly.slice(0, 5).join(', ')}).`,
    )
    say('Run apply after a nightly has passed on this commit, or hotfix if it can’t wait.')
    process.exit(1)
  }
  if (!ciPassed(head)) {
    say('CI hasn’t passed on this commit yet; the website goes once it has.')
    process.exit(1)
  }
  const site = productionSite(values, environment())
  buildWorker(site, head, say)
  moveProduction(process.env)
  deployWorker(site, head, say)
  await signInGuard()
}

/**
 * After the website goes out: every way of signing in and signing up works through cubepals.com
 * (scripts/lib/auth-through-website.ts). Sign-in is the way in, so a deploy that breaks it says so
 * at once and names the way back. Tried for a minute, while Cloudflare takes the new version.
 */
async function signInGuard(): Promise<void> {
  let failure = ''
  for (let tries = 0; tries < 6; tries++) {
    try {
      say(`Sign-in and sign-up through the website: ${await authWorks('https://cubepals.com')}.`)
      return
    } catch (error) {
      failure = (error as Error).message
      await Bun.sleep(10_000)
    }
  }
  say(`On cubepals.com, ${failure}. Roll the website back now: bun scripts/production.ts rollback website`)
  process.exit(1)
}

/**
 * Whether production answers: the API through the website, realtime's own TLS, and every machine
 * of the apps just deployed started with its checks passing. Tried for two minutes.
 */
async function answers(apps: readonly FlyApp[], env: NodeJS.ProcessEnv): Promise<boolean> {
  const reached = (url: string) =>
    fetch(url, { signal: AbortSignal.timeout(10_000) }).then(
      (response) => response.status < 500,
      () => false,
    )
  const healthy = (app: FlyApp) => {
    const listed = spawnSync('fly', ['machines', 'list', '-a', `bly-prod-${app}`, '--json'], {
      encoding: 'utf8',
      env,
    })
    const machines = JSON.parse(listed.stdout || '[]') as { state: string; checks?: { status: string }[] }[]
    return machines.every(
      (m) => m.state === 'started' && (m.checks ?? []).every((c) => c.status === 'passing'),
    )
  }
  for (let tries = 0; tries < 8; tries++) {
    const up =
      (await reached('https://cubepals.com/api/health')) && (await reached('https://rt.cubepals.com/'))
    if (up && apps.every(healthy)) return true
    await Bun.sleep(15_000)
  }
  return false
}

/**
 * A fix to production now, without a staging pass: this commit, once CI passed on it, into only
 * the Fly apps it is built into and the website if it reaches it. From main, or, when main holds
 * other work that hasn't been on staging, from a branch made from `production` with the fix
 * cherry-picked onto it. Never Terraform, which goes through apply.
 */
async function hotfix(): Promise<void> {
  const values = read()
  if (!check(values)) process.exit(1)
  requireClean()
  const head = git('rev-parse', 'HEAD')
  const paths = changedSinceLive()
  const terraform = terraformIn(paths)
  if (terraform.length > 0) {
    say(`This changes Terraform (${terraform.slice(0, 3).join(', ')}), which only apply puts in place.`)
    process.exit(1)
  }
  if (!ciPassed(head)) {
    say('CI hasn’t passed on this commit. Open a pull request for it and wait for CI, then run hotfix again.')
    process.exit(1)
  }
  const apps = appsFor(paths)
  const site = reachesWebsite(paths)
  if (apps.length === 0 && !site) {
    say('Nothing that runs in production changed since the last deploy.')
    return
  }
  const env = productionEnv(values)
  const website = site ? productionSite(values, environment()) : undefined
  if (website) buildWorker(website, head, say)
  for (const app of apps) deployApp(app, env)
  moveProduction(env)
  if (website) {
    deployWorker(website, head, say)
    await signInGuard()
  }
  const shipped = [...apps, ...(site ? ['website'] : [])].join(', ')
  if (!(await answers(apps, env))) {
    say(
      `The hotfix (${shipped}) is out, but production isn’t answering as it should. Look now; roll back with: bun scripts/production.ts rollback`,
    )
    process.exit(1)
  }
  say(
    `Hotfix ${head.slice(0, 8)} is live (${shipped}), with no staging run: the next nightly covers it on main.`,
  )
}

/** The image an app ran before the one it runs now, from its release history; null when there is none. */
function previousImage(app: FlyApp, env: NodeJS.ProcessEnv): string | null {
  const listed = spawnSync('fly', ['releases', '-a', `bly-prod-${app}`, '--image', '--json'], {
    encoding: 'utf8',
    env,
  })
  const releases = JSON.parse(listed.stdout || '[]') as { Status: string; ImageRef: string }[]
  const images = releases
    .filter((release) => release.Status === 'complete')
    .map((release) => release.ImageRef)
  return images.find((image) => image !== images[0]) ?? null
}

/**
 * Production back to what ran before, when a deploy went wrong: each Fly app to its previous image,
 * and the website to the commit it was built from before. `fly` or `website` alone, or both. It
 * doesn't undo a migration (a later release's columns stay; the older code ignores them) or a
 * secret, and the `production` branch still names the newer commit: fix forward, then deploy again.
 */
async function rollback(part: string | undefined): Promise<void> {
  const values = read()
  const env = productionEnv(values)
  const apps: FlyApp[] = part === 'website' ? [] : ['control', 'realtime', 'edge']
  for (const app of apps) {
    const image = previousImage(app, env)
    if (image === null) say(`${app}: there is no earlier image to go back to.`)
    else deployApp(app, env, image)
  }
  if (part !== 'fly' && !rollbackWebsite(productionSite(values, environment()), say))
    say('The website has no earlier version to go back to.')
  say(
    (await answers(apps, env))
      ? 'Rolled back, and production answers.'
      : 'Rolled back, but production isn’t answering yet. Look now.',
  )
}

const command = process.argv[2]
if (command === 'init') init()
else if (command === 'check') process.exit(check(read()) ? 0 : 1)
else if (command === 'apply') await apply()
else if (command === 'web') await web()
else if (command === 'hotfix') await hotfix()
else if (command === 'rollback') await rollback(process.argv[3])
else {
  say('Usage: bun scripts/production.ts init | check | apply | web | hotfix | rollback [fly|website]')
  process.exit(1)
}
