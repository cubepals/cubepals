// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A world's game rules, as the fake server keeps them and answers for them in the game's words,
 * measured on Paper 26.2-135 and Mojang's 26.2 server (2026-10-31):
 * - the names: from 1.21.11, the registry's (`keep_inventory`, `pvp`); before it, `keepInventory`,
 *   and `pvp` from 1.21.9. A name the release doesn't know, the other era's or a typo, is refused;
 * - Paper keeps each dimension's rules apart, and a bare `gamerule` reads and sets the overworld's,
 *   where `execute in <dimension> run gamerule` reaches the others; every other server type keeps
 *   one set for the whole world;
 * - they are the world's, in `<level>/gamerules`: they hold across a stop and a start, and a new
 *   world starts at the game's defaults.
 *
 * Not for PvP before 1.21.9, a property the server reads as it starts (`fake-minecraft.ts`).
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const OVERWORLD = 'minecraft:overworld'
/** The key of the one set a server that isn't Paper keeps for every dimension. */
const WHOLE_WORLD = '*'

/** Each rule the fake knows, with the game's default. */
const DEFAULTS = { keepInventory: false, pvp: true }
type Rule = keyof typeof DEFAULTS

/** Whether a release (`26.2`, `1.21.11`) is the given one or later; a missing part is 0. */
const atLeast = (version: string, [major, minor, patch]: readonly [number, number, number]) => {
  const [a = 0, b = 0, c = 0] = version.split('.').map((n) => Number.parseInt(n, 10) || 0)
  if (a !== major) return a > major
  return b !== minor ? b > minor : c >= patch
}

/** Each rule by the name the release gives it, where it is a game rule at all. */
function namesOn(version: string): Map<string, Rule> {
  const names = new Map<string, Rule>()
  if (atLeast(version, [1, 21, 11])) names.set('keep_inventory', 'keepInventory')
  else names.set('keepInventory', 'keepInventory')
  if (atLeast(version, [1, 21, 9])) names.set('pvp', 'pvp')
  return names
}

export class FakeGameRules {
  readonly #file: string
  readonly #names: Map<string, Rule>
  readonly #paper: boolean
  /** Each dimension's rules that differ from the game's defaults, by dimension and rule. */
  readonly #set: Map<string, Map<string, boolean>>

  private constructor(
    file: string,
    env: Readonly<Record<string, string>>,
    set: Map<string, Map<string, boolean>>,
  ) {
    this.#file = file
    this.#names = namesOn(String(env.VERSION))
    this.#paper = env.TYPE === 'PAPER'
    this.#set = set
  }

  /** The rules a world holds, read as the server opens it. */
  static async open(level: string, env: Readonly<Record<string, string>>): Promise<FakeGameRules> {
    const file = join(level, 'gamerules')
    const set = new Map<string, Map<string, boolean>>()
    for (const line of (await readFile(file, 'utf8').catch(() => '')).split('\n')) {
      // A line is `<dimension> <rule>=<value>`; the empty one after the last has no rule.
      const [where, rule, value] = line.split(/[ =]/) as [string, ...string[]]
      if (rule === undefined) continue
      set.set(where, (set.get(where) ?? new Map()).set(rule, value === 'true'))
    }
    return new FakeGameRules(file, env, set)
  }

  /** A rule as a dimension has it, by the fake's own name for it. */
  value(rule: Rule, dimension = OVERWORLD): boolean {
    return this.#set.get(this.#keyOf(dimension))?.get(rule) ?? DEFAULTS[rule]
  }

  /** `gamerule <name> [true|false]`, run in a dimension: the overworld, unless under `execute in`. */
  async command(name: string, value: string | undefined, dimension = OVERWORLD): Promise<string> {
    const rule = this.#names.get(name)
    if (rule === undefined)
      return `Incorrect argument for command\ngamerule ${[name, value].filter(Boolean).join(' ')}<--[HERE]`
    if (value === undefined) return `Gamerule ${name} is currently set to: ${this.value(rule, dimension)}`
    if (value !== 'true' && value !== 'false') return 'Incorrect argument for command'
    const key = this.#keyOf(dimension)
    this.#set.set(key, (this.#set.get(key) ?? new Map()).set(rule, value === 'true'))
    await writeFile(this.#file, this.#lines())
    return `Gamerule ${name} is now set to: ${value}`
  }

  #keyOf(dimension: string): string {
    return this.#paper ? dimension : WHOLE_WORLD
  }

  #lines(): string {
    return [...this.#set]
      .flatMap(([where, rules]) => [...rules].map(([rule, value]) => `${where} ${rule}=${value}\n`))
      .join('')
  }
}
