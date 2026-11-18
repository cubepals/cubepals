// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a release's server writes the two packets the edge's dialog hold builds itself, Login
 * Finished and Transfer, read from the server jar's bytecode with `javap` (`hold-packets.ts`
 * `bump`). A report gives packet ids, not layouts, and the layouts change: 26.2 added a session
 * uuid to Login Finished, and 26.4 its options byte and Transfer's query properties. A layout the
 * edge can't write is refused here, so a bump never hands a client a packet it can't read.
 *
 * What is read: the codecs a packet's `static {}` takes, in order (`StreamCodec.composite`), and
 * the `FriendlyByteBuf` writes of its `write` method, for a packet that writes itself. Releases
 * before 26.1 are obfuscated, and Mojang's mappings for the jar give the names back.
 *
 * Not for packet ids (`hold-packets.ts`), nor for writing the packets (`apps/edge/dialog-hold.ts`).
 */
import type { Layouts } from '../apps/edge/hold-packet-ids.ts'

/** The two packets, by the names the game gives their classes. */
export const PACKETS = {
  loginFinished: 'net.minecraft.network.protocol.login.ClientboundLoginFinishedPacket',
  transfer: 'net.minecraft.network.protocol.common.ClientboundTransferPacket',
} as const

/** Each layout the edge writes, by the steps the game takes to write it. */
const KNOWN: { [P in keyof Layouts]: Record<string, Layouts[P]> } = {
  loginFinished: {
    'ByteBufCodecs.GAME_PROFILE': 'profile',
    'ByteBufCodecs.GAME_PROFILE UUIDUtil.STREAM_CODEC': 'profile+session',
    'ByteBufCodecs.GAME_PROFILE UUIDUtil.STREAM_CODEC ConnectionOptionsPacket.FLAG_FIELD_STREAM_CODEC':
      'profile+session+options',
  },
  transfer: {
    'FriendlyByteBuf.writeUtf FriendlyByteBuf.writeVarInt': 'host+port',
    'ByteBufCodecs.STRING_UTF8 ByteBufCodecs.VAR_INT ByteBufCodecs.STRING_UTF8 ByteBufCodecs.STRING_UTF8 ByteBufCodecs.map':
      'host+port+properties',
  },
}

const PRIMITIVES: Record<string, string> = {
  B: 'byte',
  C: 'char',
  D: 'double',
  F: 'float',
  I: 'int',
  J: 'long',
  S: 'short',
  Z: 'boolean',
  V: 'void',
}

/** The game's names for an obfuscated jar's classes, fields and methods, from Mojang's mappings. */
export class Mappings {
  /** A jar that isn't obfuscated: every name is its own. */
  static readonly NONE = new Mappings('')
  readonly #classes = new Map<string, string>()
  readonly #obfuscated = new Map<string, string>()
  /** By obfuscated class, then `name` for a field or `name(params)` for a method, the game's name. */
  readonly #members = new Map<string, Map<string, string>>()

  /** Reads ProGuard's format, as Mojang publishes it: `name -> obf:`, then its members indented. */
  constructor(text: string) {
    let members: Map<string, string> | null = null
    const methods: { into: Map<string, string>; obf: string; params: string; name: string }[] = []
    for (const line of text.split('\n')) {
      const type = /^(\S+) -> (\S+):$/.exec(line)
      if (type) {
        members = this.#type(type[1] ?? '', type[2] ?? '')
        continue
      }
      const member = members === null ? null : memberOf(line)
      if (member === null || members === null) continue
      if (member.params === undefined) members.set(member.obf, member.name)
      else methods.push({ into: members, obf: member.obf, params: member.params, name: member.name })
    }
    for (const method of methods) this.#method(method)
  }

  /** Records a method, by its parameters in obfuscated names, as bytecode names them. */
  #method({
    into,
    obf,
    params,
    name,
  }: {
    into: Map<string, string>
    obf: string
    params: string
    name: string
  }) {
    const obfParams = params === '' ? [] : params.split(',').map((p) => this.#obfuscated.get(p) ?? p)
    into.set(`${obf}(${obfParams.join(',')})`, name)
  }

  /** Records a class's two names; its members go in what this returns. */
  #type(name: string, obf: string): Map<string, string> {
    this.#classes.set(obf, name)
    this.#obfuscated.set(name, obf)
    const members = new Map<string, string>()
    this.#members.set(obf, members)
    return members
  }

  /** The class as `javap` is given it: its obfuscated name, or the game's where there is none. */
  classFor(name: string): string {
    return this.#obfuscated.get(name) ?? name
  }

  /** A class's simple name, from its binary name as bytecode writes it (`a/b/C`). */
  simple(binary: string): string {
    const dotted = binary.replaceAll('/', '.')
    return (this.#classes.get(dotted) ?? dotted).split('.').at(-1) ?? dotted
  }

  /** A field or method's own name; `params` is the descriptor's parameter types, for a method. */
  member(binary: string, obf: string, params?: string[]): string {
    const members = this.#members.get(binary.replaceAll('/', '.'))
    const key = params === undefined ? obf : `${obf}(${params.join(',')})`
    return members?.get(key) ?? obf
  }
}

/** A member's line of the mappings: its name, obfuscated name, and parameters if it is a method. */
function memberOf(line: string): { name: string; obf: string; params?: string } | null {
  const method = /^\s+(?:[\d:]+:)?\S+ ([^\s(]+)\(([^)]*)\)\S* -> (\S+)$/.exec(line)
  if (method) return { name: method[1] ?? '', params: method[2] ?? '', obf: method[3] ?? '' }
  const field = /^\s+\S+ (\S+) -> (\S+)$/.exec(line)
  return field ? { name: field[1] ?? '', obf: field[2] ?? '' } : null
}

/** The parameter types of a method descriptor, as Java names them: `(Ljava/lang/String;I)V` is String and int. */
export function paramsOf(descriptor: string): string[] {
  const inside = /^\(([^)]*)\)/.exec(descriptor)?.[1] ?? ''
  const params: string[] = []
  let i = 0
  while (i < inside.length) {
    let arrays = ''
    while (inside[i] === '[') {
      arrays += '[]'
      i++
    }
    if (inside[i] === 'L') {
      const end = inside.indexOf(';', i)
      params.push(inside.slice(i + 1, end).replaceAll('/', '.') + arrays)
      i = end + 1
    } else {
      params.push((PRIMITIVES[inside[i] ?? ''] ?? '?') + arrays)
      i++
    }
  }
  return params
}

/** One method's instructions from `javap -c -p`, under the line that declares it. */
interface Section {
  declaration: string
  lines: string[]
}

function sectionsOf(javap: string): Section[] {
  const sections: Section[] = []
  for (const line of javap.split('\n')) {
    if (/^ {2}\S.*;$/.test(line)) sections.push({ declaration: line.trim(), lines: [] })
    else sections.at(-1)?.lines.push(line)
  }
  return sections
}

/** The name a section's declaration gives its method, in the game's names. */
function methodName(section: Section, binary: string, mappings: Mappings): string {
  if (section.declaration === 'static {};') return '<clinit>'
  const match = /\s([\w$]+)\(([^)]*)\);$/.exec(section.declaration)
  if (!match) return ''
  const params = match[2] === '' ? [] : (match[2] ?? '').split(', ')
  return mappings.member(binary, match[1] ?? '', params)
}

/**
 * The steps that write `binary`'s packet, from `javap -c -p` of it: the codecs its `static {}`
 * takes and `ByteBufCodecs.map`, then the `FriendlyByteBuf` writes of its `write`, each as
 * `Class.member` in the game's names.
 */
export function stepsOf(javap: string, binary: string, mappings: Mappings): string[] {
  const steps: string[] = []
  for (const section of sectionsOf(javap)) {
    const method = methodName(section, binary, mappings)
    if (method !== '<clinit>' && method !== 'write') continue
    for (const line of section.lines) {
      const step = stepIn(line, method, mappings)
      if (step !== null) steps.push(step)
    }
  }
  return steps
}

/** The step one instruction of `method` takes, as `Class.member`; null for one that writes nothing. */
function stepIn(line: string, method: '<clinit>' | 'write', mappings: Mappings): string | null {
  const ref =
    /\s(getstatic|invokestatic|invokevirtual)\s.*\/\/ (?:Interface)?(?:Field|Method) ([\w/$]+)\.([\w$<>]+):(\S+)/.exec(
      line,
    )
  if (!ref) return null
  const [, op, owner = '', obf = '', descriptor = ''] = ref
  const step = `${mappings.simple(owner)}.${mappings.member(owner, obf, descriptor.startsWith('(') ? paramsOf(descriptor) : undefined)}`
  if (method === 'write') return op === 'invokevirtual' && step.startsWith('FriendlyByteBuf.') ? step : null
  if (op === 'getstatic') return isCodec(descriptor, mappings) ? step : null
  return op === 'invokestatic' && step === 'ByteBufCodecs.map' ? step : null
}

/** Whether a field's type, obfuscated or not, is the game's `StreamCodec`. */
const isCodec = (descriptor: string, mappings: Mappings): boolean =>
  descriptor.startsWith('L') && mappings.simple(descriptor.slice(1, -1)) === 'StreamCodec'

/**
 * The layouts a release writes, from `javap` of each packet's class; throws, naming the packet and
 * how it is written, where the edge doesn't know that layout.
 */
export function layoutsOf(javap: (className: string) => string, mappings: Mappings): Layouts {
  const read = <P extends keyof Layouts>(packet: P): Layouts[P] => {
    const binary = mappings.classFor(PACKETS[packet])
    const steps = stepsOf(javap(binary), binary, mappings).join(' ')
    const layout = KNOWN[packet][steps]
    if (layout === undefined)
      throw new Error(
        `${PACKETS[packet]} is written as [${steps}], a layout the edge's dialog hold can't write: ` +
          'teach apps/edge/dialog-hold.ts and scripts/hold-layouts.ts it, then bump again',
      )
    return layout
  }
  return { loginFinished: read('loginFinished'), transfer: read('transfer') }
}
