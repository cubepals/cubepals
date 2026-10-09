// The TypeScript projects the checks cover: every package and app, each with its tests' own
// config where it has one, so test-only types stay out of the app's own.
import { existsSync } from 'node:fs'

const PROJECTS = [
  'packages/contracts',
  'packages/db',
  'apps/control',
  'apps/web',
  'apps/edge',
  'apps/devtools',
]

export const CONFIGS = PROJECTS.flatMap((p) =>
  ['tsconfig.json', 'tsconfig.test.json']
    .map((name) => `${p}/${name}`)
    .filter((config) => existsSync(config)),
)
