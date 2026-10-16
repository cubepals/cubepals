// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a jar's classes say about whether it is safe to run next to other people's servers, read
 * from each class's constant pool (`class-constants.ts`). Two kinds of answer:
 *
 * - **A detection**: a class named, or a string held, exactly as a list of known malware names
 *   one. MCAntiMalware matches its signatures the same way: a class's own name against its class
 *   paths, and the strings `ldc` pushes against its strings. A detection quarantines the jar.
 * - **Flags**: things the code does that a mod rarely needs. Plenty of good mods do one of them,
 *   so a flag alone never keeps a jar out; it is a note for operators to look at.
 *
 * It decides nothing about digests of whole jars; those are matched before any class is read
 * (`app/mods/jar-checks.ts`).
 */
import type { ClassConstants } from './class-constants.ts'

export type JarFlag =
  | 'loads_code_from_network'
  | 'runs_commands'
  | 'uses_unsafe'
  | 'writes_outside_server'
  | 'obfuscated'

/** Each flag as an operator reads it. */
export const FLAG_NOTES: Readonly<Record<JarFlag, string>> = {
  loads_code_from_network: 'loads classes it fetches over the network',
  runs_commands: 'runs programs on the machine (Runtime.exec or ProcessBuilder)',
  uses_unsafe: 'reaches sun.misc.Unsafe',
  writes_outside_server: 'writes files at paths outside the server’s folder',
  obfuscated: 'is obfuscated',
}

/** Where a signature comes from, and the malware it names. */
export interface Signature {
  source: string
  family: string | null
}

export interface Signatures {
  classes: ReadonlyMap<string, Signature>
  strings: ReadonlyMap<string, Signature>
}

/** What quarantined a jar: the signature it matched, as the list wrote it. */
export interface Detection extends Signature {
  match: string
}

const NETWORK = [
  'java/net/URL',
  'java/net/URLConnection',
  'java/net/HttpURLConnection',
  'java/net/Socket',
  'java/net/http/HttpClient',
]
const DEFINES_CLASSES = [
  'java/lang/ClassLoader.defineClass',
  'java/lang/invoke/MethodHandles$Lookup.defineClass',
  'java/security/SecureClassLoader.defineClass',
]
const WRITES = [
  'java/io/FileOutputStream',
  'java/io/FileWriter',
  'java/io/RandomAccessFile',
  'java/nio/file/Files.write',
  'java/nio/file/Files.writeString',
  'java/nio/file/Files.newOutputStream',
  'java/nio/file/Files.newBufferedWriter',
  'java/nio/file/Files.copy',
  'java/nio/file/Files.move',
]
/** Paths a server's own files are never under: the machine's, a user's home, or a way up and out. */
const OUTSIDE = [
  /^\/(etc|root|home|usr|var|bin|sbin|boot|opt|proc|sys|dev|lib)(\/|$)/,
  /^[A-Za-z]:[\\/]/,
  /(^|[\\/])\.\.([\\/]|$)/,
  /^~[\\/]/,
  /%APPDATA%|^user\.home$/i,
]
/** Names obfuscators write into what they protect. */
const OBFUSCATORS = /\b(ZKM|Allatori|Stringer|Skidfuscator|Paramorphism|Branchlock|Bozar|Radon|Caesium)\b/
/** A name only of `I`, `l` and `1` reads as nothing but itself: an obfuscator's. */
const CONFUSABLE = /^[Il1]{6,}$/
/** Below this many classes, short names prove nothing. */
const FEW_CLASSES = 10
/** The share of short class names past which a jar's names were taken away. */
const SHORT_SHARE = 0.6

/** A jar's classes read one at a time, then answered for as a whole. */
export class JarScan {
  readonly #signatures: Signatures
  readonly #flags = new Set<JarFlag>()
  #detection: Detection | null = null
  #classes = 0
  #short = 0

  constructor(signatures: Signatures) {
    this.#signatures = signatures
  }

  read(constants: ClassConstants): void {
    this.#detection ??= this.#detect(constants)
    const { classes, members, strings } = constants
    const uses = (name: string) => classes.has(name) || members.has(name)
    const any = (names: readonly string[]) => names.some(uses)
    if (classes.has('java/net/URLClassLoader') || (any(DEFINES_CLASSES) && any(NETWORK)))
      this.#flags.add('loads_code_from_network')
    if (members.has('java/lang/Runtime.exec') || classes.has('java/lang/ProcessBuilder'))
      this.#flags.add('runs_commands')
    if (
      classes.has('sun/misc/Unsafe') ||
      classes.has('jdk/internal/misc/Unsafe') ||
      strings.has('sun.misc.Unsafe') ||
      strings.has('theUnsafe')
    )
      this.#flags.add('uses_unsafe')
    if (any(WRITES) && [...strings].some((s) => OUTSIDE.some((path) => path.test(s))))
      this.#flags.add('writes_outside_server')
    const simple = constants.name.slice(constants.name.lastIndexOf('/') + 1)
    this.#classes++
    if (simple.length <= 2) this.#short++
    if (CONFUSABLE.test(simple) || [...strings].some((s) => OBFUSCATORS.test(s)))
      this.#flags.add('obfuscated')
  }

  result(): { detection: Detection | null; flags: JarFlag[] } {
    if (this.#classes >= FEW_CLASSES && this.#short / this.#classes >= SHORT_SHARE)
      this.#flags.add('obfuscated')
    return { detection: this.#detection, flags: [...this.#flags].sort() }
  }

  #detect(constants: ClassConstants): Detection | null {
    const byClass = this.#signatures.classes.get(constants.name)
    if (byClass !== undefined) return { ...byClass, match: constants.name }
    for (const text of constants.strings) {
      const byString = this.#signatures.strings.get(text)
      if (byString !== undefined) return { ...byString, match: text }
    }
    return null
  }
}
