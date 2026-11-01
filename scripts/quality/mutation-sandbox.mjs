// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Gives each Stryker sandbox its own workspace links. External libraries stay linked;
 * a bare workspace import must reach this sandbox's mutated source, never the original snapshot.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function inside(root, path) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
}

export function installSandboxModules(snapshotArgument, sandboxArgument) {
  const snapshot = realpathSync(snapshotArgument)
  const sandbox = realpathSync(sandboxArgument)
  if (!inside(join(snapshot, '.stryker-tmp'), sandbox))
    throw new Error('Mutation sandbox must be inside the disposable snapshot')
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: snapshot, encoding: 'utf8' }).split('\0')
  const installations = new Set(['.', ...paths.filter((path) => path.endsWith('/package.json')).map(dirname)])
  for (const directory of installations) {
    const modules = join(snapshot, directory, 'node_modules')
    if (!existsSync(modules)) continue
    const destination = join(sandbox, directory, 'node_modules')
    if (existsSync(destination))
      throw new Error('Sandbox dependencies must not be shared with another worker')
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(modules)) {
      if (entry.startsWith('@')) {
        mkdirSync(join(destination, entry))
        for (const name of readdirSync(join(modules, entry)))
          link(join(modules, entry, name), join(destination, entry, name))
      } else link(join(modules, entry), join(destination, entry))
    }
  }
  function link(source, destination) {
    const original = realpathSync(source)
    const target =
      inside(snapshot, original) && !/(?:^|\/)node_modules\//.test(relative(snapshot, original))
        ? join(sandbox, relative(snapshot, original))
        : original
    if (!existsSync(target)) throw new Error(`Missing sandbox dependency: ${relative(snapshot, original)}`)
    symlinkSync(target, destination, lstatSync(target).isDirectory() ? 'dir' : 'file')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  installSandboxModules(process.argv[2], process.cwd())
