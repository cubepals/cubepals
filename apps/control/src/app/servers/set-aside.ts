// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The files Blockly set aside for a server's start, a copy kept, and its owner's way back. A start
 * that stops because its own output named a file it may move (`minecraft/diagnosis.ts`, `files`)
 * keeps it aside once and is tried again; the start's step does the moving
 * (`minecraft/set-aside.ts`), and the server's page says what was moved and why, with "Put it
 * back", which waits for the next start as every change to what a server boots does.
 *
 * Only a file Blockly didn't place itself is ever moved: its own datapacks and jars would be placed
 * again at the next start, so a failure that names one keeps the remedy it has.
 * Not which failures name a file, nor how the step moves it.
 */
import { type Db, type Queryable, type SetAsideJson, schema } from '@blockly/db'
import { eq } from 'drizzle-orm'
import type { MinecraftServer } from '../../domain/server/server.ts'
import { type Aside, asideOf, askedBack, stillKept } from '../../minecraft/set-aside.ts'
import { type Actor, authorize, requestedBy } from '../actor.ts'
import { DiagnosedFailure, NotFound, PlainFailure } from '../errors.ts'
import type { EventBus } from '../ports/events.ts'
import type { RuntimeHandle, RuntimeSpec } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import { lockServer } from './persistence.ts'

/** What a server has set aside now, as its row keeps it, every path checked again. */
export async function loadSetAside(q: Queryable, serverId: string): Promise<SetAsideJson[]> {
  const [row] = await q
    .select({ setAside: schema.minecraftServers.setAside })
    .from(schema.minecraftServers)
    .where(eq(schema.minecraftServers.id, serverId))
  return (row?.setAside ?? []).filter((file) => asideOf(file.path, file.inWorld) !== null)
}

/**
 * A file Blockly placed itself: every jar and datapack it puts on a server is named after its bytes,
 * twelve hex characters of its SHA-512 first (`minecraft/jars.ts`, `diskName`; `datapackName`), the
 * revision's and Cubepals' own alike. It would be placed again at the next start, so it never moves.
 */
const placedByBlockly = (file: Aside): boolean => /^[0-9a-f]{12}-/.test(file.path.replace(/^.*\//, ''))

/**
 * Of the files a failure named, the one a fix may set aside, or null: a datapack Blockly didn't
 * put there, or, of the copies of a mod found twice, the one copy Blockly didn't place when another
 * copy is Blockly's. Where it can't be told which copy is the owner's, nothing moves.
 */
export function chooseAside(files: readonly Aside[]): Aside | null {
  const datapacks = files.filter((file) => file.inWorld && !placedByBlockly(file))
  if (datapacks.length === 1) return datapacks[0] ?? null
  const jars = files.filter((file) => !file.inWorld)
  const theirs = jars.filter((file) => !placedByBlockly(file))
  return theirs.length === 1 && jars.length > theirs.length ? (theirs[0] ?? null) : null
}

/**
 * A start's failure, or what replaces it: where the failure named a file a fix may set aside, and
 * that file isn't aside already, it is kept to be moved and the start is tried again. A file set
 * aside once that is named again isn't moved twice: the failure stands, with its remedy.
 */
export async function setAsideFor(
  db: Db,
  server: Pick<MinecraftServer, 'id' | 'activeWorldId'>,
  error: unknown,
): Promise<unknown> {
  if (!(error instanceof DiagnosedFailure) || error.files.length === 0) return error
  const serverId = server.id
  const file = chooseAside(error.files)
  if (file === null) return error
  const kept = await db.transaction(async (tx) => {
    const server = await lockServer(tx, serverId)
    if (server === null) return false
    const now = await loadSetAside(tx, serverId)
    const world = file.inWorld && server.activeWorldId !== null ? { worldId: server.activeWorldId } : {}
    // Aside already, from this world where it is in one: named again, it isn't moved twice.
    const same = (aside: SetAsideJson) =>
      aside.path === file.path && aside.inWorld === file.inWorld && aside.worldId === world.worldId
    if (now.some(same)) return false
    const entry: SetAsideJson = {
      ...file,
      ...world,
      why: error.message,
      at: new Date().toISOString(),
      back: false,
    }
    await tx
      .update(schema.minecraftServers)
      .set({ setAside: [...now, entry] })
      .where(eq(schema.minecraftServers.id, serverId))
    return true
  })
  if (!kept) return error
  return new PlainFailure(
    `${error.message} Cubepals set ${file.path} aside, a copy kept, and is starting it again.`,
    {
      cause: error,
    },
  )
}

/** What a server's page lists of its last start: what it left out, and what was set aside for it. */
export async function startNotes(
  q: Queryable,
  server: Pick<MinecraftServer, 'id' | 'notLoaded'>,
): Promise<{ notLoaded: string[]; setAside: SetAsideJson[] }> {
  return { notLoaded: [...server.notLoaded], setAside: await loadSetAside(q, server.id) }
}

/**
 * After a start that came up: of the files that start was asked to put back, each no longer kept
 * aside went back, and is off the list. One still kept, because something new took its place, is
 * listed as aside again, with its way back. One asked back after the start's spec was built is left
 * for the next start, which is told of it.
 */
export async function settlePutBack(
  deps: {
    db: Db
    runtime: Pick<Runtimes, 'exec'>
    bindingOf: (serverId: string) => Promise<{ handle: RuntimeHandle | null }>
  },
  serverId: string,
  desired: { spec: Pick<RuntimeSpec, 'env'> },
): Promise<void> {
  const asked = askedBack(desired.spec.env)
  if (asked.length === 0) return
  const { handle } = await deps.bindingOf(serverId)
  if (handle === null) return
  const read = await deps.runtime
    .exec(handle, stillKept(asked, desired.spec.env.LEVEL ?? 'world'), 20)
    .catch(() => null)
  if (read === null || read.exitCode !== 0) return
  const kept = new Set(read.stdout.split('\n'))
  const where = (file: Aside) => `${file.inWorld ? 'world' : 'server'} ${file.path}`
  const wasAsked = (file: Aside) => asked.some((one) => where(one) === where(file))
  await deps.db.transaction(async (tx) => {
    if ((await lockServer(tx, serverId)) === null) return
    const now = await loadSetAside(tx, serverId)
    const next = now.flatMap((file) =>
      !file.back || !wasAsked(file) ? [file] : kept.has(where(file)) ? [{ ...file, back: false }] : [],
    )
    await tx
      .update(schema.minecraftServers)
      .set({ setAside: next })
      .where(eq(schema.minecraftServers.id, serverId))
  })
}

/** The owner's way back: a file set aside goes back at the next start, or stays aside after all. */
export class SetAsideChoice {
  readonly #db: Db
  readonly #events: EventBus

  constructor(db: Db, events: EventBus) {
    this.#db = db
    this.#events = events
  }

  async putBack(actor: Actor, serverId: string, path: string, back: boolean): Promise<void> {
    if (actor.kind !== 'user') throw new NotFound('Server')
    await this.#db.transaction(async (tx) => {
      const server = authorize(actor, await lockServer(tx, serverId))
      if (server.deletedAt !== null) throw new NotFound('Server')
      const now = await loadSetAside(tx, serverId)
      if (!now.some((file) => file.path === path)) throw new NotFound('File')
      const version = server.version + 1
      await tx
        .update(schema.minecraftServers)
        .set({
          setAside: now.map((file) => (file.path === path ? { ...file, back } : file)),
          version,
          updatedAt: new Date(),
        })
        .where(eq(schema.minecraftServers.id, server.id))
      await tx.insert(schema.auditLog).values({
        actor: requestedBy(actor),
        action: back ? 'server.set_aside_put_back' : 'server.set_aside_kept',
        subjectType: 'server',
        subjectId: server.id,
        data: { path },
      })
      await this.#events.publish(tx, {
        type: 'server_changed',
        serverId: server.id,
        ownerId: server.ownerId,
        status: server.lifecycle.status,
        version,
      })
    })
  }
}
