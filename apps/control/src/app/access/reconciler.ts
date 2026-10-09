import { type Db, schema } from '@blockly/db'
import {
  type AccessCommand,
  type AccessEntry,
  type AccessRecord,
  entryKey,
  type ObservedAccess,
  type PlayerRef,
} from '../../domain/access/access.ts'
import {
  commandKey,
  importObserved,
  operatorsAndBansToWrite,
  planDelivery,
  settle,
  whitelistToWrite,
} from '../../domain/access/reconcile.ts'
import type { MinecraftServer } from '../../domain/server/server.ts'
import {
  accessCommand,
  accessFiles,
  parseAccessFiles,
  READ_ACCESS_FILES,
  writeAccessFiles,
} from '../../minecraft/access.ts'
import { PORT_NAMES } from '../../minecraft/runtime-spec.ts'
import { PlainFailure } from '../errors.ts'
import type { EventBus } from '../ports/events.ts'
import type { PlayerProfiles, ServerConsole } from '../ports/minecraft.ts'
import type { RuntimeHandle } from '../ports/runtime.ts'
import type { Runtimes } from '../runtimes/router.ts'
import type { RuntimeSpecs } from '../servers/specs.ts'
import { identityFor, keyedFor } from './identity.ts'
import { readAccess, saveReconciled } from './persistence.ts'

export class AccessReseedFailed extends PlainFailure {
  constructor(detail: string) {
    super(`Could not restore who can join this server: ${detail}`)
    this.name = 'AccessReseedFailed'
  }
}

/**
 * Brings a running server's access files and Blockly's record together (§15.1). `import` only
 * reads in-game changes; `full` also delivers what Blockly holds, or re-imposes the whole record
 * after a volume replacement.
 */
export class AccessReconciler {
  readonly #db: Db
  readonly #runtime: Runtimes
  readonly #console: ServerConsole
  readonly #profiles: PlayerProfiles
  readonly #specs: RuntimeSpecs
  readonly #events: EventBus

  constructor(deps: {
    db: Db
    runtime: Runtimes
    console: ServerConsole
    profiles: PlayerProfiles
    specs: RuntimeSpecs
    events: EventBus
  }) {
    this.#db = deps.db
    this.#runtime = deps.runtime
    this.#console = deps.console
    this.#profiles = deps.profiles
    this.#specs = deps.specs
    this.#events = deps.events
  }

  /**
   * `mayRestart`: this runs as the server boots, and may ask for one restart (`restart: true`)
   * after writing operators and bans that only load as the server starts. The boot restarts it and
   * reconciles again without it.
   */
  async reconcile(
    server: MinecraftServer,
    handle: RuntimeHandle,
    mode: 'full' | 'import',
    options: { mayRestart?: boolean } = {},
  ): Promise<{ restart: boolean }> {
    const before = await readAccess(this.#db, server.id)
    const observed = await this.#readFiles(handle)

    if (mode === 'import') {
      // Files that are about to be replaced or stop being observable: keep what players did in game.
      if (!before.record.reseedRequired)
        await this.#save(server, before, importObserved(before.record, observed))
      return { restart: false }
    }

    const reseeding = before.record.reseedRequired
    const imported = reseeding ? before.record : importObserved(before.record, observed)
    // Every player as this server knows them. After it changes whether it checks accounts, each
    // name belongs to someone else to it, and every entry is delivered again as that player.
    const working = await this.#keyedFor(imported, observed.onlineMode)
    const changedKind = working !== imported || !everyKeyed(observed, observed.onlineMode)

    if (options.mayRestart) {
      const lists = operatorsAndBansToWrite(observed, working)
      // The console names players the server's own way. Where that is not how Blockly holds them,
      // the files are written instead, and read as the server starts again.
      if (lists !== null && (!observed.onlineMode || changedKind)) {
        const whitelist = targetWhitelist(working)
        await this.#write(handle, accessFiles({ whitelist, ...lists }, new Date()), changedKind)
        await this.#save(server, before, working)
        return { restart: true }
      }
    }

    const failures = new Map<string, string>()
    const whitelist = whitelistToWrite(observed, working)
    if (whitelist !== null) {
      // The name cache stays: a running server holds its own copy, and only a restart replaces it.
      const written = await this.#write(handle, accessFiles({ whitelist }, new Date()), false).then(
        () => null,
        () => NOT_TAKEN,
      )
      if (written !== null) for (const key of pendingWhitelist(working)) failures.set(key, written)
    }
    const reload: AccessCommand[] =
      whitelist !== null || pendingWhitelist(working).length > 0 ? [{ type: 'whitelist_reload' }] : []
    const commands = [...reload, ...(await this.#withCurrentNames(planDelivery(observed, working), observed))]
    const delivered = await this.#deliver(handle, server.id, commands)
    for (const [key, error] of delivered) failures.set(key, error)
    if (delivered.has(RELOAD))
      for (const key of pendingWhitelist(working)) failures.set(key, delivered.get(RELOAD) ?? '')
    if (reseeding && failures.size > 0) {
      throw new AccessReseedFailed([...failures.values()][0] ?? 'delivery failed')
    }

    const after = await this.#readFiles(handle)
    const { record, undo } = settle(working, observed, after, failures)
    if (undo.length > 0) await this.#deliver(handle, server.id, undo)
    // IP bans can't work behind the shared edge (§15.1): the ones lifted are audited, and the
    // access page tells the owner why.
    const lifted = observed.ipBans.map((b) => b.ip).filter((ip) => !after.ipBans.some((b) => b.ip === ip))
    await this.#save(server, before, record, lifted)
    return { restart: false }
  }

  /**
   * The record as a server of this kind knows its players. An entry made for the other kind is
   * the same name, so the same person, and becomes that player here: its account where accounts
   * are checked — refused where no account has the name — and the name itself where they aren't.
   * Where the account servers don't answer, an entry keeps what it had until the next time.
   */
  async #keyedFor(record: AccessRecord, onlineMode: boolean): Promise<AccessRecord> {
    if (record.entries.every((e) => keyedFor(e.player, onlineMode))) return record
    const seen = new Set<string>()
    const entries: AccessEntry[] = []
    for (const entry of record.entries) {
      let next = entry
      if (!keyedFor(entry.player, onlineMode)) {
        const player = await identityFor(entry.player.name, onlineMode, this.#profiles).catch(() => undefined)
        if (player === null) next = { ...entry, state: 'rejected', error: NO_ACCOUNT }
        else if (player !== undefined)
          next = {
            ...entry,
            player,
            state: entry.state === 'pending_remove' ? 'pending_remove' : 'pending_add',
            error: null,
          }
      }
      const key = entryKey(next.list, next.player.uuid)
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(next)
    }
    return { ...record, entries }
  }

  /** Writes access files into the running server's volume; `forgetNames` drops its name cache too. */
  async #write(
    handle: RuntimeHandle,
    files: ReturnType<typeof accessFiles>,
    forgetNames: boolean,
  ): Promise<void> {
    const result = await this.#runtime.exec(handle, writeAccessFiles(files, forgetNames), 20)
    if (result.exitCode !== 0) throw new Error(`Writing the access files failed: ${result.stderr.trim()}`)
  }

  async #readFiles(handle: RuntimeHandle): Promise<ObservedAccess> {
    const result = await this.#runtime.exec(handle, READ_ACCESS_FILES, 20)
    if (result.exitCode !== 0) throw new Error(`Reading access files failed: ${result.stderr.trim()}`)
    return parseAccessFiles(result.stdout)
  }

  /**
   * Commands address players by name; names change hands, so resolve each account's current
   * name. A server that doesn't check accounts has no accounts to ask about: the name is the player.
   */
  async #withCurrentNames(commands: AccessCommand[], observed: ObservedAccess): Promise<AccessCommand[]> {
    if (!observed.onlineMode) return commands
    return Promise.all(
      commands.map(async (command) => {
        if (!('player' in command)) return command
        const current = await this.#profiles.byUuid(command.player.uuid).catch(() => null)
        return current ? { ...command, player: { ...command.player, name: current.name } } : command
      }),
    )
  }

  async #deliver(
    handle: RuntimeHandle,
    serverId: string,
    commands: AccessCommand[],
  ): Promise<Map<string, string>> {
    const failures = new Map<string, string>()
    if (commands.length === 0) return failures
    const target = {
      endpoint: this.#runtime.endpoint(handle, PORT_NAMES.rcon, 'control'),
      passwords: this.#specs.rconPasswords(serverId),
    }
    const results = await this.#console.runAll(target, commands.map(accessCommand))
    results.forEach((result, i) => {
      const command = commands[i]
      if (!result.ok && command) failures.set(commandKey(command) ?? command.type, NOT_TAKEN)
    })
    return failures
  }

  async #save(
    server: MinecraftServer,
    before: Awaited<ReturnType<typeof readAccess>>,
    after: typeof before.record,
    liftedIpBans: readonly string[] = [],
  ) {
    await this.#db.transaction(async (tx) => {
      const version = await saveReconciled(tx, server.id, before, after)
      for (const ip of liftedIpBans)
        await tx.insert(schema.auditLog).values({
          actor: 'system:access',
          action: 'access.ip_ban_lifted',
          subjectType: 'server',
          subjectId: server.id,
          data: { ip },
        })
      await this.#events.publish(tx, {
        type: 'access_changed',
        serverId: server.id,
        ownerId: server.ownerId,
        version,
      })
    })
  }
}

/** Where a failed reload is filed: every whitelist entry waiting for it is still waiting. */
const RELOAD = 'whitelist_reload'

/** Where an entry for a server that checks accounts names nobody with an account. */
const NO_ACCOUNT = 'No Minecraft account has this name, so it can’t join while players are checked.'
/**
 * An owner's word for a change the server didn't take: what the console or the files said is a
 * socket's or a shell's, and the change stays pending, so it's delivered again.
 */
const NOT_TAKEN = 'the server didn’t take it just then, and Cubepals will try again'

/** Whether everyone in the files is keyed the way a server of this kind keys them. */
function everyKeyed(observed: ObservedAccess, onlineMode: boolean): boolean {
  return [...observed.whitelist, ...observed.operators, ...observed.bans].every((p) =>
    keyedFor(p, onlineMode),
  )
}

/** Everyone the whitelist should hold once delivery is done. */
function targetWhitelist(record: AccessRecord): PlayerRef[] {
  return record.entries
    .filter((e) => e.list === 'whitelist' && (e.state === 'active' || e.state === 'pending_add'))
    .map((e) => e.player)
}

/** The keys of whitelist changes still waiting to land. */
function pendingWhitelist(record: AccessRecord): string[] {
  return record.entries
    .filter((e) => e.list === 'whitelist' && (e.state === 'pending_add' || e.state === 'pending_remove'))
    .map((e) => entryKey(e.list, e.player.uuid))
}
