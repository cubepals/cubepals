// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which previewed commits keep their address: those of open pull requests alone. A commit's
 * record (lib/preview-commits.ts) is what the previews' router finds its version by, so forgetting
 * it takes <sha7>.preview.cubepals.com down; the version itself stays on the Worker.
 *
 *   bun scripts/preview-commits.ts forget <n>   pull request <n>'s commits lose their addresses
 *   bun scripts/preview-commits.ts sweep        only the open pull requests' commits keep theirs
 *
 * The web-staging workflow runs these as it runs preview-uploads.ts's remove and sweep, after them,
 * since those read the records to know whose a commit's origin is: forget when a pull request
 * closes, sweep each day and on each push to main. It reads the open pull requests with GH_TOKEN
 * from REPO, and the records with CLOUDFLARE_WORKERS_API_TOKEN. Not for recording a commit: that
 * is staging-website.ts's preview.
 */
import { findCommits, forgetCommits } from './lib/preview-commits.ts'
import { openPulls } from './preview-uploads.ts'
import { stagingCloudflare } from './staging-website.ts'

const say = (line: string) => process.stdout.write(`${line}\n`)

if (import.meta.main) {
  const [command, argument = ''] = process.argv.slice(2)
  if ((command === 'forget' && /^\d+$/.test(argument)) || command === 'sweep') {
    const cloudflare = await stagingCloudflare()
    const namespace = await findCommits(cloudflare)
    let open: (pull: number) => boolean
    if (command === 'forget') {
      const closed = Number(argument)
      open = (pull) => pull !== closed
    } else {
      if (!process.env.REPO) throw new Error('REPO is not set')
      const pulls = new Set(await openPulls(process.env.REPO))
      open = (pull) => pulls.has(pull)
    }
    const gone = namespace === undefined ? 0 : await forgetCommits(cloudflare, namespace, open)
    say(gone === 0 ? 'No commit to forget.' : `Forgot ${gone} commits of closed pull requests.`)
  } else {
    say('bun scripts/preview-commits.ts forget <pull request> | sweep')
    process.exitCode = 2
  }
}
