// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Commit the staged tree using the authenticated GitHub user's verified signing service when
 * this machine has no private key. The current branch must already exist remotely at HEAD.
 * Expected-head locking rejects concurrent edits. Validate the signature and complete tree
 * before moving the local branch; unstaged edits stay in the working tree.
 * Usage: GH_TOKEN=... bun scripts/quality/signed-commit.mjs "Subject" ["Body"]
 */

import { execFileSync } from 'node:child_process'
import { subjectProblem } from '../check-subject.ts'

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}
const [headline, body = ''] = process.argv.slice(2)
const problem = subjectProblem(headline ?? '')
if (
  problem ||
  `${headline}
${body}`.includes('@')
)
  throw new Error(problem ?? 'Commit messages cannot contain mentions')
const branchName = git('symbolic-ref', '--short', 'HEAD')
const expectedHeadOid = git('rev-parse', 'HEAD')
const tree = git('write-tree')
if (tree === git('rev-parse', 'HEAD^{tree}')) throw new Error('No staged changes')
const additions = []
const deletions = []
for (const entry of git('diff', '--cached', '--name-status', '--no-renames', '-z')
  .split('\x00')
  .filter(Boolean)
  .reduce((rows, item, i) => {
    if (i % 2 === 0) rows.push([item])
    else rows[rows.length - 1].push(item)
    return rows
  }, [])) {
  const [status, path] = entry
  if (status === 'D') deletions.push({ path })
  else {
    const mode = git('ls-files', '--stage', '--', path).split(' ')[0]
    if (mode !== '100644') throw new Error(`Use a local signing key for file mode ${mode}: ${path}`)
    const contents = execFileSync('git', ['show', `:${path}`]).toString('base64')
    additions.push({ path, contents })
  }
}
const query =
  'mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid tree{oid} signature{isValid}}}}'
const payload = {
  query,
  variables: {
    input: {
      branch: { repositoryNameWithOwner: 'cubepals/cubepals', branchName },
      expectedHeadOid,
      message: { headline, body },
      fileChanges: { additions, deletions },
    },
  },
}
const response = JSON.parse(
  execFileSync('gh', ['api', 'graphql', '--input', '-'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  }),
)
if (response.errors) throw new Error(JSON.stringify(response.errors))
const commit = response.data.createCommitOnBranch.commit
if (commit.signature?.isValid !== true || commit.tree.oid !== tree) {
  throw new Error(
    `Remote commit ${commit.oid} needs inspection: signature or tree mismatch; local HEAD unchanged`,
  )
}
git('fetch', 'origin', branchName)
git('reset', '--soft', commit.oid)
console.warn(`Verified signed commit ${commit.oid}`)
