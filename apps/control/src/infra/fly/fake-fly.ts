/**
 * An in-memory Fly Machines API, faithful where the adapter depends on it.
 * Leases carry nonces and are required for changes; volumes filled from a snapshot or a fork
 * hydrate before they are ready; machines are made in `created` and can't start until Fly has
 * prepared them, then stay stopped; a stop and a destroy can take a moment to finish, and a volume
 * stays bound to its machine until the machine is gone; a first request can get a 429.
 * It holds no tests: FlyRuntime's tests against it live in `fly-runtime*.test.ts`.
 */

export type Json = Record<string, unknown>
interface FakeMachine {
  id: string
  name: string
  region: string
  state: string
  config: Json
  events: Json[]
  updated_at: string
  host_status?: 'ok' | 'unknown' | 'unreachable'
  /** Reads before Fly has prepared a machine made with skip_launch. */
  prepareReadsLeft?: number
  /** Reads while an update replaces its run, showing the old run stopped. */
  replaceReadsLeft?: number
  /** Reads while it is still stopping, or still being destroyed. */
  stopReadsLeft?: number
  destroyReadsLeft?: number
}
interface FakeVolume {
  id: string
  name: string
  region: string
  size_gb: number
  state: string
  hydrateReadsLeft: number
  snapshot_retention?: number
  snapshot_id?: string
  source_volume_id?: string
}

/**
 * Fly replaces a started machine's run when it is updated: the old run stops, the machine reads as
 * stopped with that exit, not asked for, then the new run starts with its events afresh.
 */
function replaced(machine: FakeMachine): FakeMachine {
  if (machine.replaceReadsLeft === undefined) return machine
  if (machine.replaceReadsLeft > 0) {
    machine.replaceReadsLeft--
    return machine
  }
  delete machine.replaceReadsLeft
  machine.state = 'started'
  machine.events = [{ type: 'start', status: 'started', timestamp: Date.now() }]
  return machine
}

/** Fly prepares a new machine in the background: each read of it is a moment later. */
function prepared(machine: FakeMachine): FakeMachine {
  if (machine.state !== 'created') return machine
  if ((machine.prepareReadsLeft ?? 0) <= 0) machine.state = 'stopped'
  else machine.prepareReadsLeft = (machine.prepareReadsLeft ?? 0) - 1
  return machine
}

export class FakeFly {
  readonly calls: string[] = []
  readonly apps = new Map<string, { name: string; network: string; org: string; idempotency: string }>()
  readonly ips = new Map<string, Json[]>()
  readonly secrets = new Map<string, Record<string, string>>()
  readonly volumes = new Map<string, FakeVolume[]>()
  readonly snapshots = new Map<string, Json[]>()
  readonly machines = new Map<string, FakeMachine[]>()
  readonly leases = new Map<string, string>()
  readonly jobScripts: string[] = []
  /** The signal each stop asked for. */
  readonly stopSignals: string[] = []
  /** Reads of a new machine before Fly has prepared it, and the starts it refused meanwhile. */
  prepareReads = 1
  /** Reads of an updated started machine that show its old run stopped, before the new one starts. */
  replaceReads = 0
  /** Reads of a machine still stopping after a stop, and the starts it refused meanwhile. */
  stopReads = 0
  /** Starts refused as the machine still active, though it reads stopped: Fly's stop not yet done. */
  activeStarts = 0
  /**
   * Requests that see a destroyed machine still being destroyed, its volume still bound to it; and
   * the deletes of that volume refused meanwhile.
   */
  destroyReads = 0
  boundDeletes = 0
  /**
   * New machines refused on a volume a destroyed machine had, as Fly went on holding one after its
   * machine was gone (production, 2026-10-11); and every machine refused on a claimed volume.
   */
  lingeringClaims = 0
  claimedCreates = 0
  /** Listings that still show a deleted volume as `created`, as Fly's did for a moment. */
  deletedListReads = 0
  readonly #lingering: { app: string; volume: FakeVolume; readsLeft: number }[] = []
  /** Listings of a new snapshot before Fly has finished writing it. */
  snapshotReads = 0
  /** A helper job that ended without leaving a result. */
  jobGone = false
  /** The archive an export job packs; and whether a job sending parts of it fails. */
  archiveBytes = 4096
  partsFail = false
  refusedStarts = 0
  throttleOnce = false
  /** Regions with no room left; and whether the org may use paid-only regions. */
  readonly full = new Set<string>()
  paidPlan = false
  /** While set, the error body every start and every new machine is refused with, as by a full host. */
  refusal: Json | null = null
  /** What each placement simulation asked for. */
  readonly placements: Json[] = []
  /** Destroyed machines, which the org list shows when asked to include them. */
  readonly destroyed: (FakeMachine & { app_name: string })[] = []
  /** Regions the org list reports it couldn't read. */
  readonly unreadRegions: string[] = []
  /** The query of each org list. */
  readonly orgLists: URLSearchParams[] = []
  /** Machines and volumes on a host that is gone: anything that needs the host fails. */
  readonly unreachable = new Set<string>()
  #ids = 0
  #secretsVersion = 0

  readonly fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const method = request.method
    const path = url.pathname
    this.calls.push(`${method} ${path}`)
    if (this.throttleOnce) {
      this.throttleOnce = false
      return new Response('slow down', { status: 429, headers: { 'retry-after': '0.02' } })
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(method)
      ? ((await request.json().catch(() => ({}))) as Json)
      : {}
    const json = (value: unknown, status = 200) => Response.json(value, { status })
    const missing = () => json({ error: 'not found' }, 404)
    const nonceOk = (machineId: string) =>
      this.leases.get(machineId) === request.headers.get('fly-machine-lease-nonce')
    let m: RegExpMatchArray | null

    if (path === '/v1/platform/regions')
      return json({
        Regions: [
          { code: 'fra' },
          { code: 'iad' },
          { code: 'old', deprecated: true },
          { code: 'bom', requires_paid_plan: true },
        ],
      })
    // As the live API answers: PascalCase, a region only when it has room (2026-09-19).
    if (path === '/v1/platform/placements' && method === 'POST') {
      this.placements.push(body)
      const region = String(body.region)
      const room = !this.full.has(region) && (region !== 'bom' || this.paidPlan)
      return json({ Regions: room ? [{ Region: region, Count: 1, Concurrency: 1 }] : [] })
    }
    if (path === '/v1/apps' && method === 'GET')
      return json({
        apps: [...this.apps.values()].map((a) => ({ name: a.name })),
        total_apps: this.apps.size,
      })
    if (path === '/v1/apps' && method === 'POST') {
      const name = String(body.name)
      if (this.apps.has(name)) return json({ error: 'already exists' }, 422)
      this.apps.set(name, {
        name,
        network: String(body.network),
        org: String(body.org_slug),
        idempotency: String(body.idempotency_key),
      })
      return json({ id: name, created_at: 0 }, 201)
    }
    m = path.match(/^\/v1\/apps\/([^/]+)$/)
    if (m) {
      const app = m[1] as string
      if (!this.apps.has(app)) return missing()
      if (method === 'DELETE') {
        this.apps.delete(app)
        for (const machine of this.machines.get(app) ?? []) this.#destroy(app, machine)
        this.machines.delete(app)
        this.volumes.delete(app)
        return json({})
      }
      return json({ name: app })
    }
    const appOf = (name: string) => (this.apps.has(name) ? name : null)
    m = path.match(/^\/v1\/apps\/([^/]+)\/ip_assignments$/)
    if (m) {
      const app = appOf(m[1] as string)
      if (!app) return missing()
      if (method === 'POST') this.ips.set(app, [...(this.ips.get(app) ?? []), { ip: 'fdaa:0:1::3', ...body }])
      return json({ ips: this.ips.get(app) ?? [] })
    }
    m = path.match(/^\/v1\/apps\/([^/]+)\/secrets$/)
    if (m) {
      this.secrets.set(m[1] as string, (body.values ?? {}) as Record<string, string>)
      return json({ version: ++this.#secretsVersion })
    }
    m = path.match(/^\/v1\/apps\/([^/]+)\/volumes$/)
    if (m) {
      const app = appOf(m[1] as string)
      if (!app) return missing()
      const list = this.volumes.get(app) ?? []
      if (method === 'GET') return json([...list, ...this.#lingered(app)])
      const volume: FakeVolume = {
        id: `vol_${++this.#ids}`,
        name: String(body.name),
        region: String(body.region),
        size_gb: Number(body.size_gb),
        state: body.snapshot_id || body.source_volume_id ? 'hydrating' : 'created',
        hydrateReadsLeft: 1,
        snapshot_retention: Number(body.snapshot_retention),
        ...(body.snapshot_id ? { snapshot_id: String(body.snapshot_id) } : {}),
        ...(body.source_volume_id ? { source_volume_id: String(body.source_volume_id) } : {}),
      }
      this.volumes.set(app, [...list, volume])
      return json(volume)
    }
    m = path.match(/^\/v1\/apps\/([^/]+)\/volumes\/([^/]+)(\/extend|\/snapshots)?$/)
    if (m) {
      const [, app = '', id = '', tail] = m
      const list = this.volumes.get(app) ?? []
      const volume = list.find((v) => v.id === id)
      // A deleted volume's snapshots are still listed, and restorable until they expire.
      if (!volume && tail === '/snapshots' && method === 'GET' && this.snapshots.has(id))
        return json(this.snapshots.get(id))
      if (!volume) return missing()
      if (tail === '/extend') {
        volume.size_gb = Number(body.size_gb)
        return json({ volume })
      }
      if (tail === undefined && method === 'PUT') {
        if (body.snapshot_retention !== undefined) volume.snapshot_retention = Number(body.snapshot_retention)
        return json(volume)
      }
      if (tail === '/snapshots') {
        const snaps = this.snapshots.get(id) ?? []
        if (method === 'POST') {
          // One at a time: while one is being written, Fly refuses another and says when it began.
          const writing = snaps.find((snap) => snap.status === 'pending')
          if (writing)
            return json(
              {
                error: `failed_precondition: snapshot is already scheduled at ${String(writing.created_at)}`,
              },
              412,
            )
          this.snapshots.set(id, [
            ...snaps,
            {
              id: `vs_${++this.#ids}`,
              size: 1234,
              created_at: new Date().toISOString(),
              status: 'pending',
              readsLeft: this.snapshotReads,
            },
          ])
          return new Response(null, { status: 200 })
        }
        // Listed while it is written; finished a moment later.
        for (const snap of snaps)
          if (snap.status === 'pending' && Number(snap.readsLeft ?? 0) <= 0) snap.status = 'created'
          else if (snap.status === 'pending') snap.readsLeft = Number(snap.readsLeft) - 1
        return json(snaps)
      }
      if (method === 'DELETE') return this.#deleteVolume(app, volume)
      if (volume.state === 'hydrating' && volume.hydrateReadsLeft-- <= 0) volume.state = 'created'
      return json(volume)
    }
    m = path.match(/^\/v1\/apps\/([^/]+)\/machines$/)
    if (m) {
      const app = appOf(m[1] as string)
      if (!app) return missing()
      const list = this.machines.get(app) ?? []
      if (method === 'GET') return json(list)
      return this.#create(app, body)
    }
    m = path.match(/^\/v1\/apps\/([^/]+)\/machines\/([^/]+)(?:\/(\w+))?$/)
    if (m) {
      const [, app = '', id = '', action] = m
      const list = this.machines.get(app) ?? []
      const machine = list.find((x) => x.id === id)
      if (!machine) return missing()
      // The API still answers what it last knew; everything the host must do fails.
      if (this.unreachable.has(id) && !(action === undefined && method === 'GET'))
        return json({ error: 'host unreachable' }, 503)
      switch (action) {
        case undefined:
          if (method === 'GET') return json(this.#moment(app, prepared(replaced(machine))))
          if (method === 'DELETE') return json(this.#destroying(app, machine))
          if (!nonceOk(id)) return json({ error: 'lease required' }, 412)
          if (this.refusal !== null) return json(this.refusal, 412)
          machine.config = body.config as Json
          if (!body.skip_launch && machine.state === 'started' && this.replaceReads > 0) {
            const now = Date.now()
            machine.state = 'stopped'
            machine.replaceReadsLeft = this.replaceReads
            machine.events = [
              {
                type: 'exit',
                status: 'stopped',
                // The old run saves its world and exits a few seconds after the update.
                timestamp: now + 5_000,
                request: { exit_event: { exit_code: 0, requested_stop: false } },
              },
              { type: 'update', status: 'replacing', timestamp: now },
              ...machine.events,
            ]
          } else if (!body.skip_launch) machine.state = 'started'
          machine.updated_at = new Date().toISOString()
          return json(machine)
        // Written straight to Fly's state: the machine neither restarts nor changes version.
        case 'metadata': {
          const metadata = { ...(machine.config.metadata as Record<string, string>) }
          for (const [key, value] of Object.entries(body.metadata as Record<string, string>))
            if (value === '') delete metadata[key]
            else metadata[key] = value
          machine.config = { ...machine.config, metadata }
          return new Response(null, { status: 204 })
        }
        case 'lease':
          if (method === 'POST') {
            if (this.leases.has(id)) return json({ error: 'leased' }, 409)
            const nonce = `nonce_${++this.#ids}`
            this.leases.set(id, nonce)
            return json({ nonce, expires_at: 0 }, 201)
          }
          if (this.leases.get(id) === request.headers.get('fly-machine-lease-nonce')) this.leases.delete(id)
          return json({ ok: true })
        case 'start': {
          const refused = this.#refusedStart(machine)
          if (refused) return json(refused, 412)
          machine.state = 'started'
          machine.updated_at = new Date().toISOString()
          return json({ previous_state: 'stopped' })
        }
        case 'stop':
          if (!nonceOk(id)) return json({ error: 'lease required' }, 412)
          this.stopSignals.push(String(body.signal ?? ''))
          machine.state = 'stopping'
          machine.stopReadsLeft = this.stopReads
          this.#moment(app, machine)
          machine.updated_at = new Date().toISOString()
          machine.events.unshift({
            type: 'exit',
            timestamp: Date.now(),
            request: { exit_event: { exit_code: 0, requested_stop: true } },
          })
          return json({ ok: true })
        case 'wait':
          return url.searchParams.get('state') === machine.state
            ? json({ ok: true, state: machine.state })
            : json({ error: 'timeout' }, 408)
        case 'exec': {
          // As Fly does: stdin is not passed on, so a script comes as the argument after `sh -c`.
          const [, , line = '', argument] = body.command as string[]
          if (line.startsWith('printf') && argument !== undefined) this.jobScripts.push(argument)
          const stdout = line.includes('cat /tmp/job.result') ? `${this.#jobResult()}\n` : ''
          return json({ exit_code: 0, stdout, stderr: '' })
        }
      }
    }
    m = path.match(/^\/v1\/orgs\/([^/]+)\/machines$/)
    if (m) {
      this.orgLists.push(url.searchParams)
      const after = Date.parse(url.searchParams.get('updated_after') ?? '')
      const live = [...this.machines.entries()].flatMap(([app, list]) =>
        list.map((x) => ({ ...prepared(x), app_name: app })),
      )
      const gone = url.searchParams.get('include_deleted') === 'true' ? this.destroyed : []
      const machines = [...live, ...gone]
        .filter((x) => Number.isNaN(after) || Date.parse(x.updated_at) > after)
        .map((x) => ({ ...x, config: { metadata: (x.config.metadata ?? {}) as Json } }))
      return json({
        machines,
        next_cursor: '',
        ...(this.unreadRegions.length > 0 ? { error_regions: this.unreadRegions } : {}),
      })
    }
    return json({ error: `no fake for ${method} ${path}` }, 501)
  }

  count(prefix: string) {
    return this.calls.filter((c) => c.startsWith(prefix)).length
  }

  /**
   * What the last helper job left, as its script would: an export puts the archive, or leaves it
   * for parts when it is larger than the script says one PUT carries; a parts job sends its parts.
   */
  #jobResult(): string {
    if (this.jobGone) return 'gone'
    const script = this.jobScripts.at(-1) ?? ''
    if (script.includes('put_part()')) {
      if (this.partsFail) return 'failed 1'
      const numbers = [...script.matchAll(/^ {2}put_part (\d+) /gm)].map((m) => m[1])
      return `ok ${numbers.map((n) => `${n}="etag-${n}"`).join(' ')}`
    }
    const most = /-gt (\d+) \]/.exec(script)?.[1]
    if (most === undefined) return 'ok 0123abcd 4096'
    return `ok ${this.archiveBytes > Number(most) ? 'parts' : 'put'} 0123abcd ${this.archiveBytes}`
  }

  #deleteVolume(app: string, volume: FakeVolume): Response {
    const refused = this.#refusedDelete(app, volume.id)
    if (refused) return refused
    this.volumes.set(
      app,
      (this.volumes.get(app) ?? []).filter((v) => v.id !== volume.id),
    )
    if (this.deletedListReads > 0) this.#lingering.push({ app, volume, readsLeft: this.deletedListReads })
    return Response.json({ ...volume, state: 'destroyed' })
  }

  /** Deleted volumes the listing still shows, for the reads they have left. */
  #lingered(app: string): FakeVolume[] {
    const shown = this.#lingering.filter((l) => l.app === app && l.readsLeft-- > 0)
    return shown.map((l) => ({ ...l.volume, state: 'created' }))
  }

  /** A volume that can't go now: its host is gone, or a machine is still bound to it. */
  #refusedDelete(app: string, volumeId: string): Response | null {
    if (this.unreachable.has(volumeId)) return Response.json({ error: 'host unreachable' }, { status: 503 })
    const bound = (this.machines.get(app) ?? []).find((x) =>
      (x.config.mounts as Json[] | undefined)?.some((mount) => mount.volume === volumeId),
    )
    if (bound === undefined) return null
    this.boundDeletes++
    this.#moment(app, bound)
    return Response.json(
      { error: `failed_precondition: volume is currently bound to machine: ${bound.id}` },
      { status: 412 },
    )
  }

  /** A new machine, unless Fly refuses it: its host is full, or its volume claimed. */
  #create(app: string, body: Json): Response {
    const refused = this.refusal ?? this.#claimed(app, body.config as Json)
    if (refused !== null) return Response.json(refused, { status: 412 })
    const machine: FakeMachine = {
      id: `m_${++this.#ids}`,
      name: String(body.name),
      region: String(body.region),
      state: body.skip_launch ? 'created' : 'started',
      config: body.config as Json,
      events: [],
      updated_at: new Date().toISOString(),
      prepareReadsLeft: this.prepareReads,
    }
    this.machines.set(app, [...(this.machines.get(app) ?? []), machine])
    return Response.json(machine)
  }

  /**
   * Why Fly refuses a new machine on the volume its config mounts, if it does: another machine
   * still holds it, or Fly still holds it for one it has destroyed, naming none.
   */
  #claimed(app: string, config: Json): Json | null {
    const volumeId = (config.mounts as Json[] | undefined)?.[0]?.volume
    if (volumeId === undefined) return null
    const mounts = (x: FakeMachine) =>
      (x.config.mounts as Json[] | undefined)?.some((m) => m.volume === volumeId)
    const holder = (this.machines.get(app) ?? []).find(mounts)
    const lingering = holder === undefined && this.lingeringClaims > 0 && this.destroyed.some(mounts)
    if (holder === undefined && !lingering) return null
    if (lingering) this.lingeringClaims--
    else this.#moment(app, holder as FakeMachine)
    this.claimedCreates++
    return {
      error: `failed_precondition: volume already claimed by machine ${holder?.id ?? '\u0000'.repeat(14)}`,
    }
  }

  /**
   * Why Fly refuses to start the machine now, if it does: its host is full, or it is still being
   * prepared or stopped.
   */
  #refusedStart(machine: FakeMachine): Json | null {
    if (this.refusal !== null) return this.refusal
    if (machine.state === 'stopped' && this.activeStarts > 0) {
      this.activeStarts--
      this.refusedStarts++
      return { error: 'failed_precondition: machine still active, refusing to start' }
    }
    if (machine.state !== 'created' && machine.state !== 'stopping') return null
    this.refusedStarts++
    return { error: `failed_precondition: unable to start machine from current state: '${machine.state}'` }
  }

  /** A destroy asked for: Fly answers at once and finishes it in the background. */
  #destroying(app: string, machine: FakeMachine): Json {
    if (machine.state !== 'destroying') {
      machine.state = 'destroying'
      machine.destroyReadsLeft = this.destroyReads
      this.#moment(app, machine)
    }
    return { ok: true }
  }

  /**
   * A stop or a destroy finishing in the background: each request that sees the machine is a moment
   * later. A destroyed machine leaves the app's list, and lets its volume go, once it is done.
   */
  #moment(app: string, machine: FakeMachine): FakeMachine {
    if (machine.state === 'stopping') {
      machine.stopReadsLeft = (machine.stopReadsLeft ?? 0) - 1
      if (machine.stopReadsLeft < 0) machine.state = 'stopped'
    }
    if (machine.state === 'destroying') {
      machine.destroyReadsLeft = (machine.destroyReadsLeft ?? 0) - 1
      if (machine.destroyReadsLeft >= 0) return machine
      this.#destroy(app, machine)
      machine.state = 'destroyed'
      this.machines.set(
        app,
        (this.machines.get(app) ?? []).filter((x) => x.id !== machine.id),
      )
    }
    return machine
  }

  #destroy(app: string, machine: FakeMachine) {
    this.destroyed.push({
      ...machine,
      app_name: app,
      state: 'destroyed',
      updated_at: new Date().toISOString(),
    })
  }
}
