// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What went wrong, read out of the server's own output (§15.6). Minecraft's failures are long
 * Java stack traces; what someone needs is the one sentence that says what happened and the one
 * thing that fixes it. This is the only place that knows those signatures.
 *
 * Every pattern here is matched against lines the server or the image printed, so nothing here
 * is guessed from a message Blockly wrote itself. The loaders' own wording was checked against
 * their source on 2026-09-26: Fabric Loader, Fabric's Mixin, Quilt Loader, FancyModLoader
 * (NeoForge) and ModLauncher, and against real server logs of each.
 */

import { modName, someNames } from './pack-build.ts'

/** What Blockly can offer to do about it, which the app turns into a single action. */
export type Remedy =
  /** Nothing the owner can do; Blockly's own problem, which it says plainly. */
  | 'ours'
  /** A bigger size. */
  | 'more_room'
  /** The mods, which the owner changes. */
  | 'mods'
  /** The modpack, whose version is gone or broken. */
  | 'modpack'
  /** A backup, where the world itself won't open. */
  | 'restore'
  /** Starting it again: something that passes. */
  | 'retry'

export interface Diagnosis {
  /** What happened, in the owner's words, with no jargon and no stack trace. */
  summary: string
  remedy: Remedy
  /**
   * The mods that stopped it because they only run in players' games, where the output names
   * them, each by its name and its id where printed: a pack server can start again without them
   * (docs/modpack-system.md § Verify).
   */
  playersOnly?: Array<{ name: string; id: string | null }>
  /**
   * A mod another one needs and doesn't find, by the id its loader named: a pack server can start
   * again with it, where Blockly was the one that left it out.
   */
  missing?: string
}

interface Signature {
  /** Matched against each line. */
  pattern: RegExp
  /** Lines this signature never reads, however well they match: a warning is not a failure. */
  ignore?: RegExp
  /** `at` is the matching line's place in `lines`: what is printed around it names the culprit. */
  diagnose(match: RegExpExecArray, lines: readonly string[], at: number): Diagnosis
}

/** Jars a stack trace passes through that are Java, a loader, a library or Minecraft, never a mod. */
const PLATFORM_JAR =
  /^(?:fabric(?:-|$)|server-intermediary|intermediary|minecraft|(?:neo)?forge(?:-\d|$)|fmlloader|fmlcore|javafmllanguage|lowcodelanguage|mclanguage|loader-\d|bootstraplauncher|modlauncher|securejarhandler|eventbus|coremods|(?:sponge-)?mixin|launchwrapper|server-\d|client-\d|datafixerupper|brigadier|authlib|guava|gson|netty|log4j)/i

/**
 * The mod a stack trace blames: the first frame's jar that isn't Java, a loader or Minecraft.
 * Frames name their jar as `~[missingmodschecker.jar:?]`, or on Forge and NeoForge as
 * `~[oculus-mc1.20.1-1.6.9.jar%23191!/:?]`.
 */
function modJarIn(trace: readonly string[]): string | null {
  for (const line of trace) {
    const jar = /\[([^\]\s:%/]+?)\.jar(?:%23\d+!\/?)?:/.exec(line)?.[1]
    if (jar !== undefined && !PLATFORM_JAR.test(jar)) return jar
  }
  return null
}

/**
 * Forge and NeoForge name a mod that failed by its name and id together: "Oculus (oculus) has
 * failed to load correctly", "Lees Creatures (leescreatures) encountered an error during the
 * load_registries event phase". The name is the one its owner knows it by.
 */
const NAMED_FAILURE =
  /^\s*(?:-\s+|Failure message: )?(?!\[)(\S.*?) \(([\w.-]+)\) (?:has failed to load correctly|has class loading errors|encountered an error)/

/** The loaders naming a mod by its id alone, where its code threw. */
const MOD_ID =
  /Failed to create mod instance\. ModID: ([\w.-]+)|provided by '([\w.-]+)'|dispatch for modid ([\w.-]+)|Caught exception from ([\w.-]+)|^-- (?:MOD|Mod loading issue for:) ([\w.-]+) --/

/** A crash report's `Mod File: /data/mods/oculus-mc1.20.1-1.6.9.jar`. */
const MOD_FILE = /Mod file: (\S+\.jar)/i

function idIn(line: string): string | null {
  const found = MOD_ID.exec(line)
  return found?.slice(1).find((group) => group !== undefined) ?? null
}

/**
 * The name a mod goes by, where the output says it anywhere: its failure, or the mod list a crash
 * report prints (`|Oculus |oculus |` from 1.13 on, `oculus{1.6.9} [Oculus]` before).
 */
function nameOf(lines: readonly string[], id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const listed = new RegExp(
    `\\|\\s*([^|]+?)\\s*\\|\\s*${escaped}\\s*\\||\\b${escaped}\\{[^}]*\\} \\[([^\\]]+)\\]`,
  )
  for (const line of lines) {
    const failed = NAMED_FAILURE.exec(line)
    if (failed?.[2] === id && failed[1] !== undefined) return failed[1]
  }
  for (const line of lines) {
    const found = listed.exec(line)
    const name = found?.[1] ?? found?.[2]
    if (name !== undefined) return name
  }
  return id
}

/**
 * The mod a failure at `at` belongs to. Loaders print whose code threw just above the trace
 * (Forge's "Failed to create mod instance. ModID: oculus", Fabric's "provided by 'journeymap'"),
 * so the nearest such line above wins; then the trace's own frames; then a crash report printed
 * after it.
 */
function blamed(lines: readonly string[], at: number): string | null {
  for (let i = at; i >= Math.max(0, at - 80); i -= 1) {
    const line = lines[i] ?? ''
    const named = NAMED_FAILURE.exec(line)?.[1]
    if (named !== undefined) return named
    const id = idIn(line)
    if (id !== null) return nameOf(lines, id)
  }
  const jar = modJarIn(lines.slice(at, at + 60))
  if (jar !== null) return modName(jar)
  const below = lines.slice(at + 1)
  for (const line of below) {
    const named = NAMED_FAILURE.exec(line)?.[1]
    if (named !== undefined) return named
  }
  for (const line of below) {
    const file = MOD_FILE.exec(line)?.[1]
    if (file !== undefined) return modName(file)
  }
  for (const line of below) {
    const id = idIn(line)
    if (id !== null) return nameOf(lines, id)
  }
  return null
}

/** Mixin names a mod's config file, not the mod: `mixins.carryon.json` is Carry On's. */
function modOfMixinConfig(config: string): string {
  const parts = config
    .replace(/^.*\//, '')
    .replace(/\.json$/i, '')
    .split('.')
    .filter((part) => !/^mixins?$/i.test(part))
  return modName(parts.join('-').replace(/[-_](?:common|client|server)$/i, ''))
}

/** The mod behind a Mixin failure: Fabric's Mixin says "from mod lithium", Forge's the config. */
function mixinOwner(trace: readonly string[]): string | null {
  for (const line of trace) {
    const id = /\b(?:from|for) mod ([\w.-]+)/.exec(line)?.[1]
    if (id !== undefined) return id
  }
  for (const line of trace) {
    const config = /([\w.-]*mixins?[\w.-]*\.json)[:\]]/i.exec(line)?.[1]
    if (config !== undefined) return modOfMixinConfig(config)
  }
  return null
}

/** Dependencies Blockly chooses itself: a mod that needs another of these is Blockly's to fix. */
const CHOSEN_BY_BLOCKLY = new Map([
  ['java', 'Java'],
  ['fabricloader', 'Fabric Loader'],
  ['quilt_loader', 'Quilt Loader'],
  ['forge', 'Forge'],
  ['neoforge', 'NeoForge'],
])

/**
 * One mod needing another, by name. `missing` is null where the loader doesn't say whether the
 * other is absent or at the wrong version (Forge up to 1.12).
 */
function needs(mod: string, dependency: { id: string; name?: string }, missing: boolean | null): Diagnosis {
  if (dependency.id.toLowerCase() === 'minecraft')
    return { summary: `${mod} is made for another version of Minecraft.`, remedy: 'mods' }
  const chosen = CHOSEN_BY_BLOCKLY.get(dependency.id.toLowerCase())
  if (chosen !== undefined)
    return {
      summary: `${mod} needs another version of ${chosen}. Cubepals picks that itself, so this is ours to fix.`,
      remedy: 'ours',
    }
  const name = dependency.name ?? dependency.id
  const summary =
    missing === null
      ? `${mod} needs a version of ${name} that isn’t installed.`
      : missing
        ? `${mod} needs ${name}, which isn’t installed.`
        : `${mod} needs another version of ${name}.`
  return { summary, remedy: 'mods', ...(missing === false ? {} : { missing: dependency.id }) }
}

/** Fabric's line for one mod's need it can't meet (the signature below). */
const FABRIC_NEED =
  /Mod '([^']+)' \([\w.-]+\)(?: \S+)? (requires|is incompatible with) .+? of (?:mod )?(?:'([^']+)' \()?([\w.-]+)\)?, (which is missing|but only the wrong version|which is disabled|but a matching version is present|yet (?:a )?conflicting version)/

/** What a mod reaching for the game's screen on a server fails with. */
const CLIENT_CLASS =
  /net\/minecraft\/client\/|invalid dist DEDICATED_SERVER|not present on the dedicated server|environment type SERVER/

/** A warning line: the loaders print failures they recover from at WARN, and those aren't why it stopped. */
const WARNING = /[/ ]WARN\]/

/**
 * Ordered: the first that matches wins, so specific signatures come before general ones. Out of
 * memory comes first because it prints a stack trace that looks like a dozen other failures.
 */
const SIGNATURES: readonly Signature[] = [
  {
    // Metaspace and "GC overhead limit exceeded" are memory running out too, under other names.
    pattern: /OutOfMemoryError|There is insufficient memory for the Java Runtime|GC overhead limit exceeded/,
    diagnose: () => ({
      summary:
        'It ran out of memory while loading. Its world, mods or players need more room than this size has.',
      remedy: 'more_room',
    }),
  },
  {
    /**
     * The disk its files live on filled up. Every size starts on the same disk, and Blockly grows
     * it as the world does, so a bigger size wouldn't help: this is Blockly's to fix.
     */
    pattern: /No space left on device/,
    diagnose: () => ({
      summary:
        'Cubepals ran out of room for this server’s files. Nothing about your server is wrong; this one is ours.',
      remedy: 'ours',
    }),
  },
  {
    /**
     * A mod that opens a window as the server starts, which a server can't: it has no screen.
     * Better MC's Modrinth edition was the first seen (2026-09-24): it can't ship 34 of its mods,
     * which are on CurseForge alone, so it bundles Missing Mods Checker, which opens a window
     * asking each player to download them by hand. A server can do neither; taking the checker
     * out only let the next missing piece crash it, so the pack is the thing to change.
     */
    pattern: /java\.awt\.HeadlessException/,
    diagnose: (_, lines, at) => {
      const jar = modJarIn(lines.slice(at, at + 40))
      if (jar !== null && /missingmodschecker/i.test(jar))
        return {
          summary:
            'Its modpack leaves some of its mods for each player to download by hand, which a server can’t do, so it can’t run as a server. Pick another pack to play.',
          remedy: 'modpack',
        }
      return {
        summary: `${jar === null ? 'A mod' : modName(jar)} opens a window as the server starts, and a server has no screen: it belongs in players’ games only.`,
        remedy: 'mods',
        ...(jar === null ? {} : { playersOnly: [{ name: modName(jar), id: null }] }),
      }
    },
  },
  {
    /**
     * A loader older than the Java it was started with: ASM that can't read the newer class files,
     * or Forge up to 1.12, whose launcher expects Java 8's class loader. Blockly picks the Java.
     */
    pattern:
      /Unsupported class file major version \d+|ClassLoaders\$AppClassLoader cannot be cast to class java\.net\.URLClassLoader/,
    diagnose: () => ({
      summary:
        'It needs an older Java than the one Cubepals started it with. Cubepals picks the Java itself, so this is ours to fix.',
      remedy: 'ours',
    }),
  },
  {
    /**
     * The same mod twice: Fabric's "Duplicate versions for mod ID 'fabric'", Forge's "Found a
     * duplicate mod Baubles at [a.jar, b.jar]" (up to 1.12) and "Mod ID: 'rubidium' from mod
     * files: a.jar, b.jar" (after), NeoForge's "Mod jei is present in multiple files: a.jar, b.jar".
     */
    pattern:
      /Duplicate versions for mod ID '([\w.-]+)'|\bduplicate mod ([\w.-]+)(?: at \[([^\]]+)\])?|Mod ID: '([\w.-]+)' from mod files: (.+)|Mod (\S+) is present in multiple files: (.+)|Two versions of module (\S+) found/,
    diagnose: (match) => {
      const id = match[1] ?? match[2] ?? match[4] ?? match[6] ?? match[8] ?? ''
      const files = (match[3] ?? match[5] ?? match[7] ?? '').split(/,\s*/).filter((file) => file !== '')
      const names = [...new Set(files.map((file) => modName(file.trim())))]
      if (names.length >= 2)
        return {
          summary: `${names[0]} and ${names[1]} are the same mod, so only one of them can be installed.`,
          remedy: 'mods',
        }
      return { summary: `Two copies of ${names[0] ?? id} are installed.`, remedy: 'mods' }
    },
  },
  {
    // Two mods that carry the same code, which Java's modules refuse to load side by side.
    pattern:
      /ResolutionException: Modules (\S+) and (\S+) export package|ResolutionException: Module (\S+) contains package \S+, module (\S+) exports package/,
    diagnose: (match) => {
      // Modules are named like packages (`com.llamalad7.mixinextras`); the last part is the mod's.
      const first = (match[1] ?? match[3] ?? '').replace(/^.*\./, '')
      const second = (match[2] ?? match[4] ?? '').replace(/^.*\./, '')
      return first === second
        ? { summary: `Two copies of ${first} are installed.`, remedy: 'mods' }
        : { summary: `${first} and ${second} can’t be installed together.`, remedy: 'mods' }
    },
  },
  {
    /**
     * Fabric's own account of what doesn't fit, a line per mod under "Some of your mods are
     * incompatible with the game or each other!": `- Mod 'Iris' (iris) 1.7.0 requires any version
     * of fabric-api, which is missing!`, or `… requires version 0.5.3 of mod 'Sodium' (sodium),
     * but only the wrong version is present: 0.4.10!`, or `… is incompatible with …`.
     */
    pattern: FABRIC_NEED,
    diagnose: (first, lines) => {
      // Fabric lists every need it can't meet; one the owner can act on says more than a loader
      // build Blockly picks, so it is the one named.
      const match =
        lines
          .map((line) => FABRIC_NEED.exec(line))
          .find(
            (found) =>
              found !== null &&
              found[2] === 'requires' &&
              !CHOSEN_BY_BLOCKLY.has((found[4] ?? '').toLowerCase()) &&
              (found[4] ?? '').toLowerCase() !== 'minecraft',
          ) ?? first
      const mod = match[1] ?? ''
      const dependency = { id: match[4] ?? '', name: match[3] ?? match[4] ?? '' }
      if (match[2] !== 'requires')
        return { summary: `${mod} can’t run alongside ${dependency.name}.`, remedy: 'mods' }
      if (match[5] === 'which is disabled')
        return {
          summary: `${mod} needs ${dependency.name}, which only runs in players’ games.`,
          remedy: 'mods',
        }
      return needs(mod, dependency, match[5] === 'which is missing')
    },
  },
  {
    // Fabric before 0.12: "Could not find required mod: fabric requires {minecraft @ [~1.17]}".
    pattern: /Could not find required mod: ([\w.-]+) requires \{([\w.-]+) @/,
    diagnose: (match) => needs(match[1] ?? '', { id: match[2] ?? '' }, null),
  },
  {
    // Anything else Fabric says is missing: the first line is enough.
    pattern: /requires (?:any version of |version .* of )?['"]?([\w .-]+?)['"]?,? which is missing/i,
    diagnose: (match) => ({
      summary: `A mod needs ${match[1]}, which isn’t installed. Cubepals installs what a mod needs when you add it, so this one was put there another way.`,
      remedy: 'mods',
      missing: match[1] ?? '',
    }),
  },
  {
    // Forge from 1.13, under "Missing or unsupported mandatory dependencies:".
    pattern:
      /Mod ID: '([\w.-]+)', Requested by: '([\w.-]+)', Expected range: '[^']*', Actual version: '([^']*)'/,
    diagnose: (match, lines) =>
      needs(nameOf(lines, match[2] ?? ''), { id: match[1] ?? '' }, match[3] === '[MISSING]'),
  },
  {
    /**
     * NeoForge, and Forge from 1.14 to 1.16: "Mod alexsmobs requires citadel 2.6.0 or above", with
     * "Currently, citadel is not installed" (or its version) on the line under it.
     */
    pattern:
      /(?:^\s*(?:-\s+)?|Exception: |Failure message: )Mod (?!')(.+?) (requires|is incompatible with) ([\w.-]+)/,
    diagnose: (match, lines, at) => {
      const mod = nameOf(lines, match[1] ?? '')
      const dependency = match[3] ?? ''
      if (match[2] !== 'requires')
        return { summary: `${mod} can’t run alongside ${dependency}.`, remedy: 'mods' }
      const now = lines
        .slice(at + 1, at + 4)
        .map((line) => /Currently, ([\w.-]+) is (.*)$/.exec(line))
        .find((found) => found?.[1] === dependency)
      return needs(mod, { id: dependency }, now === undefined ? null : /not installed/.test(now?.[2] ?? ''))
    },
  },
  {
    /**
     * Forge up to 1.12: "MissingModsException: Mod cofhcore (CoFH Core) requires
     * [redstoneflux@[2.1.0,2.2.0)]", or "The mod ArchimedesShipsPlus (Archimedes' Ships Plus)
     * requires mods [MovingWorld] to be available". It doesn't say which: missing, or too old.
     */
    pattern: /(?:MissingModsException: Mod|The mod) \S+ \((.+)\) requires (?:mods )?\[([\w.-]+)/,
    diagnose: (match) => needs(match[1] ?? '', { id: match[2] ?? '' }, null),
  },
  {
    pattern: /The mod ([\w.-]+) does not wish to run in Minecraft version/,
    diagnose: (match, lines) => needs(nameOf(lines, match[1] ?? ''), { id: 'minecraft' }, null),
  },
  {
    // Forge's header over its list of what's missing, where the list itself didn't make it.
    pattern: /Missing or unsupported mandatory dependencies/,
    diagnose: () => ({ summary: 'A mod needs another mod that isn’t installed.', remedy: 'mods' }),
  },
  {
    pattern:
      /Incompatible mod set|Mod resolution (?:failed|encountered an incompatible)|Incompatible mods found|Some of your mods are incompatible with the game or each other/i,
    diagnose: () => ({
      summary: 'Its mods can’t run together on this Minecraft. Removing the newest one usually settles it.',
      remedy: 'mods',
    }),
  },
  {
    /**
     * A mod made for players' games alone, which reached for the game's screen or controls on a
     * server that has neither: Forge's "Attempted to load class … for invalid dist
     * DEDICATED_SERVER", NeoForge's missing `net/minecraft/client/` classes, Fabric's "Cannot
     * load class … in environment type SERVER", and mods that refuse by themselves. Forge's dist
     * cleaner also logs the same words for classes Mixin only looked at, which is no failure: its
     * own line (`DISTXFORM`) and the warning after it are never read.
     */
    pattern:
      /Attempted to load class \S+ for invalid dist DEDICATED_SERVER|Attempted to load class \S+ which is not present on the dedicated server|NoClassDefFoundError: net\/minecraft\/client\/|Cannot load class \S+ in environment type SERVER|Attempting to load a clientside only mod/,
    ignore: /[/ ]WARN\]|\/DISTXFORM\]/,
    diagnose: (_, lines, at) => {
      // Forge lists every mod that failed at once, each with what it reached for.
      const listed = lines.flatMap((line, i) => {
        const named = NAMED_FAILURE.exec(line)
        const reason = lines.slice(i, i + 3).join('\n')
        return named !== null && CLIENT_CLASS.test(reason)
          ? [{ name: named[1] ?? '', id: named[2] ?? null }]
          : []
      })
      const mod = blamed(lines, at)
      const mods = listed.length > 0 ? listed : mod === null ? [] : [{ name: mod, id: null as string | null }]
      const names = [...new Set(mods.map((m) => m.name))]
      return {
        summary: `${names.length === 0 ? 'One of its mods' : someNames(names)} only ${names.length > 1 ? 'run' : 'runs'} in players’ games, and stopped the server as it started.`,
        remedy: 'mods',
        ...(mods.length === 0 ? {} : { playersOnly: mods }),
      }
    },
  },
  {
    /**
     * A mod changing Minecraft's code where that code isn't what it expected: another Minecraft,
     * or another mod changing the same place. Mixin logs the failures it can carry on from at
     * WARN; only those it can't are read.
     */
    pattern:
      /Mixin (?:apply|prepare) (?:for mod ([\w.-]+) )?failed|in config \[[^\]]+\] FAILED during [A-Z]+|Critical injection failure|MixinTransformerError: An unexpected critical error/,
    ignore: WARNING,
    diagnose: (match, lines, at) => {
      const mod = match[1] ?? mixinOwner(lines.slice(at, at + 40))
      return {
        summary: `${mod ?? 'One of its mods'} doesn’t work with this Minecraft or with the other mods.`,
        remedy: 'mods',
      }
    },
  },
  {
    // A mod that throws while the server starts, however its loader words it.
    pattern:
      /Failed to create mod instance\. ModID: ([\w.-]+)|Exception caught during firing event.*mod (?:id )?'?([\w-]+)'?|(?:Could not execute entrypoint stage|Exception while loading entries for entrypoint) '[^']+'.*? provided by '([\w.-]+)'|^\s*(?:-\s+|Failure message: )?(?!\[)(\S.*?) \([\w.-]+\) (?:has failed to load correctly|encountered an error)|Caught exception from ([\w.-]+)/,
    diagnose: (match, lines, at) => ({
      summary: `${blamed(lines, at) ?? match.slice(1).find((group) => group !== undefined) ?? 'A mod'} stopped the server while it was starting. It may not work with the others, or with this Minecraft.`,
      remedy: 'mods',
    }),
  },
  {
    /**
     * Blockly's own link for the pack file did not serve it. Whatever is wrong is on this side,
     * and telling the owner to go and look at their modpack would be a lie — the first live run
     * of a pack server failed exactly this way, with a 404 from the artifact endpoint, and an
     * earlier version of this file called it a pack that had been taken down.
     */
    pattern: /artifacts\/[0-9a-f-]{36}\/[0-9a-f]{128}\/\S*\s+failed with (?:40[34]|50\d)/,
    diagnose: () => ({
      summary:
        'Cubepals couldn’t hand the server its files. Nothing about your server is wrong; this one is ours.',
      remedy: 'ours',
    }),
  },
  {
    // The catalogue itself no longer has it: the version was taken down where it was published.
    pattern: /Unable to locate requested project|cdn\.modrinth\.com\S*failed with 40\d/,
    diagnose: () => ({
      summary: 'Its modpack couldn’t be installed: the version Cubepals pinned isn’t published any more.',
      remedy: 'modpack',
    }),
  },
  {
    // Anything else in the pack install: the pack is the thing to look at.
    pattern: /Failed to install.*[Mm]odpack|install-modrinth-modpack.*failed/i,
    diagnose: () => ({
      summary: 'Its modpack couldn’t be installed. Cubepals can try another version of the pack.',
      remedy: 'modpack',
    }),
  },
  {
    pattern:
      /Failed to (?:load|read) (?:the )?world|world is corrupt|ChunkLoadingException|Exception reading .*\.mca|level\.dat.*(?:corrupt|missing)/i,
    diagnose: () => ({
      summary: 'Its world didn’t open. Cubepals keeps backups, and the most recent one loads as it was.',
      remedy: 'restore',
    }),
  },
  {
    pattern: /UnsupportedClassVersionError|has been compiled by a more recent version of the Java Runtime/,
    diagnose: () => ({
      summary:
        'Something it runs was built for a newer Java than this Minecraft uses. Cubepals picks the Java itself, so this is ours to fix.',
      remedy: 'ours',
    }),
  },
  {
    pattern: /Address already in use|FAILED TO BIND TO PORT|Perhaps a server is already running/i,
    diagnose: () => ({
      summary: 'Its port was still held by the last run. Starting it again clears that.',
      remedy: 'retry',
    }),
  },
  {
    pattern: /You need to agree to the EULA|Unable to access jarfile|Could not find or load main class/,
    diagnose: () => ({
      summary:
        'The server didn’t get as far as starting. Nothing about it is yours to fix — Cubepals sets all of that.',
      remedy: 'ours',
    }),
  },
]

/** Every server type says this once it has started: what went wrong before it didn't stop it. */
const DONE = /\bDone \(\d+(?:[.,]\d+)?s\)! For help, type "help"/

/** Minecraft's own colour codes (`§e`), which NeoForge's messages carry, and terminal colours. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what it matches
const CODES = /§.|\u001b\[[0-9;?]*[ -/]*[@-~]/g

/**
 * The failure a run's last output describes, or null when nothing here recognises it. Lines come
 * newest last, as a log reads; every one is looked at, since a crash report's cause is often far
 * above the last line. Only what came after the server last said it had started counts: a
 * modded server's healthy start is full of errors it recovered from.
 */
export function diagnose(lines: readonly string[]): Diagnosis | null {
  const plain = lines.map((line) => line.replace(CODES, ''))
  const read = plain.slice(plain.findLastIndex((line) => DONE.test(line)) + 1)
  for (const signature of SIGNATURES) {
    for (const [at, line] of read.entries()) {
      if (signature.ignore?.test(line)) continue
      const match = signature.pattern.exec(line)
      if (match !== null) return signature.diagnose(match, read, at)
    }
  }
  return null
}
