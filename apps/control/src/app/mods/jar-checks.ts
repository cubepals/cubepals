// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Uploaded jars checked for malware before any server runs them (§15.2). Three steps:
 *
 * - **At upload** (`start`), in the request: the jar's digests looked up in the lists of known
 *   malware. A match is refused there and then. Anything else is queued to be read.
 * - **On a worker** (`run`, the `jar-check` job): every class read (`minecraft/jar-scan.ts`),
 *   nested jars too. A list's signature quarantines; bytecode flags are a note for operators.
 * - **As the lists change** (`refresh`, the `malware-lists` job): each list fetched again from
 *   where it is published (`ports/malware.ts`). A jar already uploaded that a list now names is
 *   quarantined, and its owners are told it comes off at their server's next start.
 *
 * A pack's jars, while the pack is built (`packs/build.ts`), kept or left to players' games: each
 * one it carries, wherever it is placed, read the same way (`check`); each one it lists by its
 * download held to the lists by the digests the pack gives (`lookUp`), which only refuse the
 * pack, since a pack's word alone quarantines nothing. A jar a pack left out, which a start finds
 * another mod needs, is looked up the same way before its servers run it (`packs/contents.ts`).
 * Either way the jar's check is kept by its sha512, so a list that names it later quarantines it,
 * its pack's servers leave it out at their next start, and their owners are told. A carried jar's
 * check holds all its digests; a listed one's holds its sha512, and its sha1 only where the
 * catalog vouches for it, so a list that names a listed jar later by its sha1 alone finds it only
 * then. A pack's jar has no bytes kept of its own to read again: when the lists change, its
 * answer stands until a pack carrying it is next built, which reads it again, and tells the
 * owners of servers that run it if it is found to be malware.
 *
 * A quarantined jar is kept out of every server: never pinned, left out of each start's spec
 * (`servers/specs.ts`), a pack's by its path, and never handed to a runtime
 * (`artifacts/service.ts`). The owner's world and other files are never touched. An operator who
 * finds it isn't malware releases it.
 */
import { MINUTE_S } from '@blockly/contracts/durations'
import { type Db, schema, type Tx } from '@blockly/db'
import { and, type Column, eq, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm'
import { classConstants } from '../../minecraft/class-constants.ts'
import {
  FLAG_NOTES,
  type JarFlag,
  JarScan,
  type Signature,
  type Signatures,
} from '../../minecraft/jar-scan.ts'
import { emailOf } from '../accounts/persistence.ts'
import { type OperatorActor, requestedBy } from '../actor.ts'
import type { DeploymentCapabilities } from '../capabilities.ts'
import { jarTakenOff } from '../emails/servers.ts'
import { NotFound } from '../errors.ts'
import { type FileFormats, UnreadableFile } from '../ports/formats.ts'
import type { JobQueue } from '../ports/jobs.ts'
import type { MalwareLists } from '../ports/malware.ts'
import type { ArchiveStore } from '../ports/optional.ts'
import type { Mailer } from '../ports/platform.ts'
import {
  allowed,
  digestsOf,
  type Finding,
  type JarCheck,
  type JarDigests,
  knownBad,
} from './jar-check-records.ts'
import { readAll } from './uploads.ts'

const checks = schema.jarChecks
const signatures = schema.malwareSignatures
const sources = schema.malwareSources

/** Long enough to read a jar back from the store. */
const READ_LINK_SECONDS = 10 * MINUTE_S
/** Jars inside jars, as Fabric carries them, read this deep. */
const NESTED_DEPTH = 3
/** No class is this large; a nested jar may be, up to an upload's own limit. */
const MAX_ENTRY_BYTES = 128 * 1024 * 1024
/** Rows written to the lists' table in one statement. */
const INSERT_BATCH = 1000

/** One jar's check as an operator reads it, with who uploaded it and what each flag means. */
interface JarCheckView {
  sha512: string
  state: JarCheck['state']
  finding: Finding | null
  flags: Array<{ flag: string; note: string }>
  releasedBy: string | null
  checkedAt: string | null
  uploads: Array<{ uploadId: string; ownerId: string; fileName: string }>
}

export class JarChecks {
  readonly #db: Db
  readonly #jobs: Pick<JobQueue, 'enqueueJarCheck'>
  readonly #lists: MalwareLists | null
  readonly #formats: FileFormats
  readonly #archive: ArchiveStore | null
  readonly #mailer: Mailer
  readonly #webOrigin: string

  constructor(deps: {
    db: Db
    jobs: Pick<JobQueue, 'enqueueJarCheck'>
    formats: FileFormats
    capabilities: Pick<DeploymentCapabilities, 'archives' | 'malware'>
    mailer: Mailer
    webOrigin: string
  }) {
    this.#db = deps.db
    this.#jobs = deps.jobs
    this.#lists = deps.capabilities.malware ?? null
    this.#formats = deps.formats
    this.#archive = deps.capabilities.archives
    this.#mailer = deps.mailer
    this.#webOrigin = deps.webOrigin
  }

  /**
   * An upload's digests, looked up before anything of it is kept: a jar a list names is
   * quarantined, and returned for the upload to be refused. Null for any other.
   */
  async screen(digests: Pick<JarDigests, 'sha1' | 'sha512'> & Partial<JarDigests>): Promise<JarCheck | null> {
    const [known] = await this.#db.select().from(checks).where(eq(checks.sha512, digests.sha512))
    if (known !== undefined && known.releasedBy !== null) return null
    if (known?.state === 'quarantined') return known
    if (await allowed(this.#db, digests.sha1)) return null
    const finding = await knownBad(this.#db, digests)
    if (finding === null) return null
    return this.#db.transaction(async (tx) => {
      const set = { ...digests, state: 'quarantined' as const, finding, checkedAt: new Date() }
      const [row] = await tx
        .insert(checks)
        .values(set)
        .onConflictDoUpdate({ target: checks.sha512, set })
        .returning()
      if (row === undefined) throw new Error('The check just recorded is missing')
      await audit(tx, 'system:jar-check', 'mods.jar_quarantined', digests.sha512, { finding })
      return row
    })
  }

  /**
   * A jar a pack lists by its download, whose bytes aren't here to read, by the digests the pack
   * gives (`claimed`) and the sha1 the catalog has for its sha512 (`vouched`), where it has one.
   * A quarantined check or a list that names any of them refuses the pack and nothing more: the
   * pack's word alone quarantines no jar. Any other is kept as a check unread, by its sha512 and
   * the catalog's sha1 alone, so a list that names it later by its sha512, or by its sha1 where
   * the catalog vouches for one, quarantines it. What matched, or null.
   */
  async lookUp(
    claimed: Pick<JarDigests, 'sha512'> & Partial<Pick<JarDigests, 'sha1'>>,
    vouched: string | null,
  ): Promise<Pick<Finding, 'match'> | null> {
    const [known] = await this.#db.select().from(checks).where(eq(checks.sha512, claimed.sha512))
    const released = known !== undefined && known.releasedBy !== null
    if (!released && known?.state === 'quarantined') return { match: known.finding?.match ?? 'quarantined' }
    // A release holds for the bytes an operator looked at: digests the catalog vouches for.
    if (released && (claimed.sha1 ?? null) === vouched) return null
    const finding = await knownBad(this.#db, claimed)
    if (finding !== null) return finding
    await this.#db
      .insert(checks)
      .values({ sha512: claimed.sha512, sha1: vouched, state: 'clean' })
      .onConflictDoUpdate({
        target: checks.sha512,
        set: { sha1: sql`coalesce(${checks.sha1}, excluded.sha1)` },
      })
    return null
  }

  /**
   * An upload's check, begun in the transaction that records it: a jar read before keeps its
   * answer; any other is queued to be read, and can't go on a server until it has been.
   */
  async start(tx: Tx, digests: JarDigests): Promise<void> {
    const [known] = await tx.select().from(checks).where(eq(checks.sha512, digests.sha512))
    if (settled(known)) return
    const set = { sha1: digests.sha1, sha256: digests.sha256, state: 'checking' as const }
    await tx.insert(checks).values(digests).onConflictDoUpdate({ target: checks.sha512, set })
    await this.#jobs.enqueueJarCheck(tx, digests.sha512)
  }

  /** `jar-check`: one jar read whole, and what it was found to be kept. */
  async run(sha512: string): Promise<void> {
    const [check] = await this.#db.select().from(checks).where(eq(checks.sha512, sha512))
    if (check === undefined || check.state === 'quarantined' || check.releasedBy !== null) return
    const [stored] = await this.#db
      .select()
      .from(schema.storedArtifacts)
      .where(eq(schema.storedArtifacts.sha512, sha512))
    // Bytes that are no longer kept run nowhere; nothing is left to check.
    if (stored === undefined || this.#archive === null) return
    const link = await this.#archive.presignGet(stored.key, READ_LINK_SECONDS, 'browser')
    const bytes = await readAll(link.url, stored.sizeBytes)
    const digests = digestsOf(bytes)
    if (digests.sha512 !== sha512) throw new Error(`The stored jar ${sha512} holds other bytes`)
    if ((await this.#judge(bytes, digests)).state === 'quarantined') await this.#tellOwners(sha512)
  }

  /**
   * A jar a pack carries, held here to what an upload is: its digests looked up, then every class
   * read, and the answer kept like an upload's, so a list that names it by a digest later
   * quarantines it. A jar read since the lists last changed keeps its answer. One quarantined here
   * may run already, on other servers or in other packs: their owners are told, as `run` tells them.
   */
  async check(bytes: Uint8Array): Promise<JarCheck> {
    const digests = digestsOf(bytes)
    const [known] = await this.#db.select().from(checks).where(eq(checks.sha512, digests.sha512))
    if (settled(known)) return known
    const found = (await this.screen(digests)) ?? (await this.#judge(bytes, digests))
    if (found.state === 'quarantined' && found.releasedBy === null) await this.#tellOwners(found.sha512)
    return found
  }

  /** A jar read whole, and what it was found to be kept as its check. */
  async #judge(bytes: Uint8Array, digests: JarDigests): Promise<JarCheck> {
    const found = (await allowed(this.#db, digests.sha1))
      ? { finding: null, flags: [] }
      : await this.#read(bytes, digests, await this.#signatures(), 0)
    const state: JarCheck['state'] =
      found.finding !== null ? 'quarantined' : found.flags.length > 0 ? 'flagged' : 'clean'
    return this.#db.transaction(async (tx) => {
      const set = { ...digests, state, finding: found.finding, flags: found.flags, checkedAt: new Date() }
      const [row] = await tx
        .insert(checks)
        .values(set)
        .onConflictDoUpdate({ target: checks.sha512, set })
        .returning()
      if (row === undefined) throw new Error('The check just recorded is missing')
      await audit(tx, 'system:jar-check', `mods.jar_${state}`, digests.sha512, {
        finding: found.finding,
        flags: found.flags,
      })
      return row
    })
  }

  /**
   * `malware-lists`: each list fetched again. One that changed replaces what was kept of it; then
   * every jar uploaded is held to the lists as they are now. A list that can't be fetched keeps
   * what was kept of it. Returns how many jars were quarantined.
   */
  async refresh(): Promise<number> {
    let changed = false
    const lists = this.#lists
    for (const source of lists?.sources ?? []) {
      const list = await lists?.fetch(source).catch((error: unknown) => {
        console.warn(
          `malware-lists: ${source} not fetched: ${error instanceof Error ? error.message : error}`,
        )
        return null
      })
      if (list === null || list === undefined) continue
      const [kept] = await this.#db.select().from(sources).where(eq(sources.source, source))
      const now = new Date()
      if (kept?.digest === list.digest) {
        await this.#db.update(sources).set({ fetchedAt: now }).where(eq(sources.source, source))
        continue
      }
      changed = true
      await this.#db.transaction(async (tx) => {
        await tx.delete(signatures).where(eq(signatures.source, source))
        const rows = list.entries.map((entry) => ({ source, ...entry }))
        for (let i = 0; i < rows.length; i += INSERT_BATCH)
          await tx
            .insert(signatures)
            .values(rows.slice(i, i + INSERT_BATCH))
            .onConflictDoNothing()
        const kept = { url: list.url, digest: list.digest, entries: rows.length, fetchedAt: now }
        await tx
          .insert(sources)
          .values({ source, ...kept })
          .onConflictDoUpdate({ target: sources.source, set: kept })
      })
    }
    const quarantined = await this.#byDigest()
    if (changed) await this.#readAgain()
    await this.#unchecked()
    return quarantined
  }

  /** The checks operators look at: quarantined and flagged jars, and those not yet read. */
  async list(states: ReadonlyArray<JarCheck['state']> = ['quarantined', 'flagged', 'checking']) {
    const rows = await this.#db
      .select()
      .from(checks)
      .where(inArray(checks.state, [...states]))
      .orderBy(sql`${checks.checkedAt} DESC NULLS FIRST`)
    const uploads =
      rows.length === 0
        ? []
        : await this.#db
            .select({
              sha512: schema.modUploads.sha512,
              uploadId: schema.modUploads.id,
              ownerId: schema.modUploads.ownerId,
              fileName: schema.modUploads.fileName,
            })
            .from(schema.modUploads)
            .where(
              inArray(
                schema.modUploads.sha512,
                rows.map((r) => r.sha512),
              ),
            )
    return rows.map(
      (row): JarCheckView => ({
        sha512: row.sha512,
        state: row.state,
        finding: row.finding,
        flags: row.flags.map((flag) => ({ flag, note: FLAG_NOTES[flag as JarFlag] ?? flag })),
        releasedBy: row.releasedBy,
        checkedAt: row.checkedAt?.toISOString() ?? null,
        uploads: uploads.filter((u) => u.sha512 === row.sha512).map(({ sha512: _, ...u }) => u),
      }),
    )
  }

  /** An operator who looked at a quarantined jar and found it isn't malware lets it run again. */
  async release(actor: OperatorActor, sha512: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const [row] = await tx
        .update(checks)
        .set({ releasedBy: requestedBy(actor) })
        .where(and(eq(checks.sha512, sha512), eq(checks.state, 'quarantined')))
        .returning()
      if (row === undefined) throw new NotFound('Quarantined jar')
      await audit(tx, requestedBy(actor), 'mods.jar_released', sha512, { finding: row.finding })
    })
  }

  /** Jars a list now names by their digest, quarantined; returns how many. */
  async #byDigest(): Promise<number> {
    const named = await this.#db
      .select({ sha512: checks.sha512, sha1: checks.sha1, sha256: checks.sha256 })
      .from(checks)
      .innerJoin(
        signatures,
        sql`(${signatures.kind} = 'sha512' AND ${signatures.value} = ${checks.sha512})
          OR (${signatures.kind} = 'sha256' AND ${signatures.value} = ${checks.sha256})
          OR (${signatures.kind} = 'sha1' AND ${signatures.value} = ${checks.sha1})`,
      )
      .where(and(ne(checks.state, 'quarantined'), isNull(checks.releasedBy)))
    const jars = [...new Map(named.map((n) => [n.sha512, n])).values()]
    for (const jar of jars) {
      if (jar.sha1 !== null && (await allowed(this.#db, jar.sha1))) continue
      const finding = await knownBad(this.#db, {
        sha512: jar.sha512,
        ...(jar.sha1 === null ? {} : { sha1: jar.sha1 }),
        ...(jar.sha256 === null ? {} : { sha256: jar.sha256 }),
      })
      await this.#db.transaction(async (tx) => {
        await tx
          .update(checks)
          .set({ state: 'quarantined', finding, checkedAt: new Date() })
          .where(eq(checks.sha512, jar.sha512))
        await audit(tx, 'system:jar-check', 'mods.jar_quarantined', jar.sha512, { finding })
      })
      await this.#tellOwners(jar.sha512)
    }
    return jars.length
  }

  /**
   * A new signature may be in a jar already read, so every jar read before is read again: one
   * whose bytes are kept, now; a pack's, which has none of its own, when a pack carrying it is
   * next built (`check`), its answer standing until then.
   */
  async #readAgain(): Promise<void> {
    const read = and(inArray(checks.state, ['clean', 'flagged']), isNull(checks.releasedBy))
    const kept = this.#db.select({ sha512: schema.storedArtifacts.sha512 }).from(schema.storedArtifacts)
    const stored = await this.#db
      .select({ sha512: checks.sha512 })
      .from(checks)
      .where(and(read, inArray(checks.sha512, kept)))
    await this.#db.transaction(async (tx) => {
      await tx
        .update(checks)
        .set({ checkedAt: null })
        .where(and(read, notInArray(checks.sha512, kept)))
      for (const { sha512 } of stored) await this.#jobs.enqueueJarCheck(tx, sha512)
    })
  }

  /** Jars uploaded before checks existed, queued to be read. */
  async #unchecked(): Promise<void> {
    const known = this.#db.select({ sha512: checks.sha512 }).from(checks)
    const missing = await this.#db
      .selectDistinct({ sha512: schema.modUploads.sha512 })
      .from(schema.modUploads)
      .where(notInArray(schema.modUploads.sha512, known))
    if (missing.length === 0) return
    await this.#db.transaction(async (tx) => {
      await tx
        .insert(checks)
        .values(missing.map(({ sha512 }) => ({ sha512 })))
        .onConflictDoNothing()
      for (const { sha512 } of missing) await this.#jobs.enqueueJarCheck(tx, sha512)
    })
  }

  /** What a list now holds of class names and strings, by the value matched. */
  async #signatures(): Promise<Signatures> {
    const rows = await this.#db
      .select()
      .from(signatures)
      .where(inArray(signatures.kind, ['class', 'string']))
    const of = (kind: 'class' | 'string') =>
      new Map<string, Signature>(
        rows.filter((r) => r.kind === kind).map((r) => [r.value, { source: r.source, family: r.family }]),
      )
    return { classes: of('class'), strings: of('string') }
  }

  /** A jar's classes read, then each jar it carries, as deep as Fabric nests them. */
  async #read(
    bytes: Uint8Array,
    digests: JarDigests,
    known: Signatures,
    depth: number,
  ): Promise<{ finding: Finding | null; flags: string[] }> {
    if (depth > 0) {
      const finding = await knownBad(this.#db, digests)
      if (finding !== null) return { finding, flags: [] }
    }
    const scan = new JarScan(known)
    const nested: Uint8Array[] = []
    let unreadable = false
    try {
      const { skipped } = this.#formats.eachZipEntry(bytes, {
        wanted: (name) => name.endsWith('.class') || (depth < NESTED_DEPTH && name.endsWith('.jar')),
        maxEntryBytes: MAX_ENTRY_BYTES,
        visit: (name, data) => {
          if (name.endsWith('.jar')) nested.push(data)
          else {
            const constants = classConstants(data)
            if (constants === null) unreadable = true
            else scan.read(constants)
          }
        },
      })
      if (skipped.length > 0) unreadable = true
    } catch (error) {
      if (!(error instanceof UnreadableFile)) throw error
      unreadable = true
    }
    const result = scan.result()
    if (result.detection !== null) return { finding: result.detection, flags: [] }
    const flags = new Set<string>(result.flags)
    if (unreadable) flags.add('unreadable')
    for (const inner of nested) {
      const found = await this.#read(inner, digestsOf(inner), known, depth + 1)
      if (found.finding !== null) return { finding: found.finding, flags: [] }
      for (const flag of found.flags) flags.add(flag)
    }
    return { finding: null, flags: [...flags].sort() }
  }

  /**
   * Each server running a jar now quarantined, as a mod it pins or one of its pack's jars: its
   * owner told it comes off at the next start, once for each server, however it runs it.
   */
  async #tellOwners(sha512: string): Promise<void> {
    const running = [...(await this.#pinning(sha512)), ...(await this.#playing(sha512))]
    // A server pinning the jar as a mod that runs it in its pack too is told once, by the mod's name.
    const once = new Map<string, ServerRunning>()
    for (const r of running) if (!once.has(r.server.id)) once.set(r.server.id, r)
    for (const { server, fileName } of once.values()) {
      const to = await emailOf(this.#db, server.ownerId)
      if (to === null) continue
      await this.#mailer
        .send({ to, ...jarTakenOff({ server, fileName, origin: this.#webOrigin }) })
        .catch((error: unknown) => console.error('jar-check: telling the owner', error))
    }
  }

  /** The servers pinning a jar as a mod, each with the jar's file name. */
  async #pinning(sha512: string): Promise<ServerRunning[]> {
    const pinning = await this.#db
      .select({ ...serverColumns, mods: schema.serverRevisions.mods })
      .from(schema.minecraftServers)
      .innerJoin(
        schema.serverRevisions,
        eq(schema.serverRevisions.id, schema.minecraftServers.desiredRevisionId),
      )
      .where(
        and(
          ne(schema.minecraftServers.status, 'purged'),
          // Served by the jsonb_path_ops index on mods.
          sql`${schema.serverRevisions.mods} @> ${JSON.stringify([{ artifact: { sha512 } }])}::jsonb`,
        ),
      )
    return pinning.flatMap(({ mods, ...server }) => {
      const mod = mods.find((m) => m.artifact.sha512 === sha512)
      return mod === undefined ? [] : [{ server, fileName: mod.artifact.fileName }]
    })
  }

  /**
   * The servers playing a pack that runs a jar, as one of its mods, one it places elsewhere, or
   * one it left out that a mod of it needs: each with the jar's file name in the pack.
   */
  async #playing(sha512: string): Promise<ServerRunning[]> {
    const contents = schema.packContents
    const holds = (column: Column, entry: object) => sql`${column} @> ${JSON.stringify([entry])}::jsonb`
    const playing = await this.#db
      .select({
        ...serverColumns,
        jars: contents.jars,
        otherJars: contents.otherJars,
        leftOut: contents.leftOut,
      })
      .from(schema.minecraftServers)
      .innerJoin(
        schema.serverRevisions,
        eq(schema.serverRevisions.id, schema.minecraftServers.desiredRevisionId),
      )
      .innerJoin(
        contents,
        sql`${contents.sha512} = ${schema.serverRevisions.modpack} -> 'artifact' ->> 'sha512'`,
      )
      .where(
        and(
          ne(schema.minecraftServers.status, 'purged'),
          or(
            holds(contents.jars, { sha512 }),
            holds(contents.otherJars, { sha512 }),
            holds(contents.leftOut, { sha512, why: 'needed' }),
          ),
        ),
      )
    return playing.flatMap(({ jars, otherJars, leftOut, ...server }) => {
      // A jar its pack left out after all (a crash) is off already.
      const off = new Set(leftOut.filter((l) => l.why !== 'needed').map((l) => l.path))
      const runs = [...jars, ...otherJars, ...leftOut.filter((l) => l.why === 'needed')]
      const path = runs.find((jar) => jar.sha512 === sha512 && !off.has(jar.path))?.path
      return path === undefined ? [] : [{ server, fileName: path.split('/').pop() ?? path }]
    })
  }
}

/** A server's columns its owner's email names. */
const serverColumns = {
  id: schema.minecraftServers.id,
  name: schema.minecraftServers.name,
  ownerId: schema.minecraftServers.ownerId,
}

/** A server running a jar, and the jar's file name as its owner knows it. */
interface ServerRunning {
  server: { id: string; name: string; ownerId: string }
  fileName: string
}

/**
 * Whether a jar's check is an answer to keep: quarantined, or read whole since the lists last
 * changed. A jar still to be read, one a pack only lists (`lookUp`) and a pack's jar the lists
 * changed after (`#readAgain`) have none yet; the last two say so by no `checkedAt`.
 */
function settled(check: JarCheck | undefined): check is JarCheck {
  if (check === undefined || check.state === 'checking') return false
  return check.state === 'quarantined' || check.checkedAt !== null
}

async function audit(
  tx: Tx,
  actor: string,
  action: string,
  sha512: string,
  data: Record<string, unknown>,
): Promise<void> {
  await tx.insert(schema.auditLog).values({ actor, action, subjectType: 'jar', subjectId: sha512, data })
}
