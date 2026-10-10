/**
 * Production, from nothing (docs/production.md). Every secret and account value lives in one file
 * the operator keeps, local/production/production.env, and every decided one in the environment's
 * config.auto.tfvars.json, made from the committed example beside it. Nothing commits either.
 *
 *   bun scripts/production.ts init    writes that file: each value with where to get it, the random
 *                                     ones already made. Run again, it keeps what is there
 *   bun scripts/production.ts check   says which values are missing or wrong, and starts the control
 *                                     plane's own configuration check on them, as a machine will
 *   bun scripts/production.ts apply   check, then Terraform (it shows the plan and asks), then the
 *                                     control, realtime and edge apps deployed from this checkout,
 *                                     then this commit pushed as the `production` branch, which
 *                                     Vercel builds, and released as the next vX.Y.Z (versions.ts).
 *                                     Only a commit a nightly passed on staging goes, unless
 *                                     --without-staging says otherwise. The first time, it stops
 *                                     after making the archive and dumps buckets, so their tokens can
 *                                     be made for them. After Terraform, it gives the Database dump
 *                                     workflow its secrets, in the repository's `production` environment
 *   bun scripts/production.ts web     main's commit pushed as the `production` branch, for Vercel to
 *                                     build, when nothing the Fly apps are built from changed since
 *                                     the last deploy and main's CI passed on it: no staging pass,
 *                                     no Fly deploy (production-web.ts says which paths are which)
 *
 * Needs terraform, flyctl and gh. Nothing here prints a value, only names.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
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
import { flyInputs } from './production-web.ts'
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
 * The Database dump workflow's secrets, in the repository's `production` environment. Only `main`'s
 * workflows reach them, and `production`'s, which Vercel's deployments name; a branch's never do.
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

function apply(): void {
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

  // Inherited Fly credentials would win over production's, and a shell set up for staging has staging's.
  const env: NodeJS.ProcessEnv = { ...process.env, ...terraformEnv(values) }
  delete env.FLY_ACCESS_TOKEN
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

  terraform('apply', '-input=false')
  setDumpSecrets(values, env)
  const deploy = (app: string, dockerfile: string, ...extra: string[]) =>
    run(
      'fly',
      [
        'deploy',
        '.',
        '--config',
        `infra/fly/${app}.toml`,
        '--dockerfile',
        dockerfile,
        '--app',
        `bly-prod-${app}`,
        '--remote-only',
        '--yes',
        ...extra,
      ],
      env,
    )
  // The control app first: its release runs the migrations. One machine a role, as
  // FLY_PLATFORM_MACHINES counts them. A second machine each comes once a blip matters.
  deploy('control', 'apps/control/Dockerfile', '--ha=false')
  deploy('realtime', 'apps/control/Dockerfile', '--ha=false')
  deploy('edge', 'apps/edge/Dockerfile', '--ha=false')
  run('git', ['push', 'origin', 'HEAD:production'], env)
  const version = `v${nextVersion(repositoryTags())}`
  const notes = passed ? `Ran on staging as ${passed}.` : 'Deployed without a staging run.'
  run(
    'gh',
    [
      'release',
      'create',
      version,
      '--target',
      git('rev-parse', 'HEAD'),
      '--latest',
      '--generate-notes',
      '--notes',
      notes,
    ],
    env,
  )
  say('')
  say(`Production is ${version}, and Vercel is building cubepals.com from the production branch.`)
  say('Check it as docs/production.md § Check it says.')
}

/** The website alone to production: main's commit, when only the website changed since the last deploy. */
function web(): void {
  if (git('status', '--porcelain') !== '') {
    say('This checkout has changes that aren’t committed. Production deploys a commit: commit or stash them.')
    process.exit(1)
  }
  git('fetch', '--quiet', 'origin', 'main', 'production')
  const head = git('rev-parse', 'HEAD')
  if (head !== git('rev-parse', 'origin/main')) {
    say('Only main’s latest commit goes to production. Check out main and pull it.')
    process.exit(1)
  }
  if (spawnSync('git', ['merge-base', '--is-ancestor', 'origin/production', 'HEAD']).status !== 0) {
    say('The production branch isn’t behind this commit. Run apply, which deploys everything.')
    process.exit(1)
  }
  const fly = flyInputs(git('diff', '--name-only', 'origin/production', 'HEAD').split('\n').filter(Boolean))
  if (fly.length > 0) {
    say(
      `Since the last deploy, what the Fly apps are built from changed too (${fly.slice(0, 5).join(', ')}).`,
    )
    say('Run apply, after a nightly has passed on this commit.')
    process.exit(1)
  }
  const ci = spawnSync(
    'gh',
    [
      'run',
      'list',
      '--branch',
      'main',
      '--workflow',
      'CI',
      '--commit',
      head,
      '--json',
      'conclusion',
      '-q',
      '.[0].conclusion',
    ],
    { encoding: 'utf8' },
  ).stdout.trim()
  if (ci !== 'success') {
    say(`CI on this commit is ${ci || 'not run'}; the website goes once it has passed.`)
    process.exit(1)
  }
  run('git', ['push', 'origin', 'HEAD:production'], process.env)
  say('Vercel is building cubepals.com from the production branch.')
}

const command = process.argv[2]
if (command === 'init') init()
else if (command === 'check') process.exit(check(read()) ? 0 : 1)
else if (command === 'apply') apply()
else if (command === 'web') web()
else {
  say('Usage: bun scripts/production.ts init | check | apply | web')
  process.exit(1)
}
