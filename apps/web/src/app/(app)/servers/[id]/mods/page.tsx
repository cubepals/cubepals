'use client'

import type { ModChangeInput, ModsView, ModView, ServerView } from '@blockly/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, ExternalLink, Plus, RefreshCw, Upload } from 'lucide-react'
import Image from 'next/image'
import { useState } from 'react'
import { messageOf, useTRPC } from '../../../../../lib/api'
import { useDebounced } from '../../../../../lib/hooks'
import { bytes, datapacksSaid, loaderLabel, presentConflict, presentPlan } from '../../../../../lib/present'
import { putFile, sha512Of } from '../../../../../lib/upload'
import {
  Badge,
  Button,
  EmptyState,
  FileButton,
  FormRow,
  FormSection,
  GetPack,
  ICON,
  LoadFailed,
  Note,
  PageSkeleton,
  ProgressBar,
  Skeleton,
  TextField,
} from '../../../../../ui'
import { PackDrop } from '../../../pack-drop'
import { PlusOffer } from '../../../plus-offer'
import {
  ChangeState,
  ConfirmChange,
  changeable,
  RevokedChoice,
  useChanged,
  whatHappens,
} from '../settings/shared'
import { useServer } from '../use-server'

type Change = Omit<ModChangeInput, 'serverId'>

/**
 * A server playing a modpack has no mod list of its own: the pack chose them, installs them and
 * updates them together. Saying that is more use than a list of two hundred names nobody here
 * picked, and it is what a player needs to know to join. A newer version is offered, never put on
 * by itself; a pack its owner uploaded takes a newer file of it instead.
 */
function PlayingAPack({ view, list }: { view: ServerView; list: ModsView }) {
  const pack = list.modpack
  const [moving, setMoving] = useState<PackMove | null>(null)
  if (pack === null) return null
  const allowed = changeable(view)
  const update = list.packUpdate
  return (
    <>
      <ChangeState view={view} />
      <FormSection
        title="It plays a modpack"
        description={
          pack.environment === 'server'
            ? `Its mods and its settings come with the pack, and friends join with plain Minecraft ${list.gameVersion}.`
            : `Its mods, its settings and its world generation come with the pack. Everyone playing needs this exact version, on Minecraft ${list.gameVersion}.`
        }
        actions={
          update !== null ? (
            <Button
              variant="outline"
              icon={<RefreshCw {...ICON} aria-hidden />}
              disabled={!allowed.ok}
              onClick={() =>
                setMoving({
                  // A pack Blockly offers by name moves to the release it offers, never a catalog version.
                  to:
                    update.release !== null
                      ? { kind: 'curated', version: update.release }
                      : { kind: 'catalog', versionId: update.versionId },
                  name: pack.name,
                  version: update.label,
                  gameVersion: update.gameVersion,
                  movesWorld: update.movesWorld,
                })
              }
            >
              Update to {update.label}
            </Button>
          ) : undefined
        }
      >
        {update !== null && (
          <Note tone="info">
            {pack.name} {update.label} is out
            {update.movesWorld ? `, on Minecraft ${update.gameVersion}` : ''}. The server stays on{' '}
            {pack.version} until you update it.
          </Note>
        )}
        <GetPack pack={pack} gameVersion={list.gameVersion} />
        {list.packLeftOut.length > 0 && (
          <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
            Left to players’ games, since they don’t run on a server: {someOf(list.packLeftOut)}.
          </p>
        )}
      </FormSection>
      {list.packUploaded && (
        <FormSection
          title="A newer version of your pack"
          description="Drop its file, and Cubepals reads it and moves the server to it, keeping a way back."
        >
          <PackDrop
            disabled={!allowed.ok}
            onReady={(read) =>
              setMoving({
                to: { kind: 'import', importId: read.importId },
                name: read.pack.name,
                version: read.pack.version,
                gameVersion: read.pack.gameVersion,
                movesWorld: read.pack.gameVersion !== list.gameVersion,
              })
            }
          />
        </FormSection>
      )}
      {moving !== null && <MovePack view={view} list={list} move={moving} onClose={() => setMoving(null)} />}
    </>
  )
}

interface PackMove {
  to:
    | { kind: 'catalog'; versionId: string }
    | { kind: 'curated'; version: string }
    | { kind: 'import'; importId: string }
  name: string
  version: string
  gameVersion: string
  movesWorld: boolean
}

/**
 * The last look before a pack changes: from what, to what, and that a world moved to a newer
 * Minecraft can't go back. It goes like any change: a snapshot first, and the pack before it back
 * by itself if the new one doesn't start.
 */
function MovePack({
  view,
  list,
  move,
  onClose,
}: {
  view: ServerView
  list: ModsView
  move: PackMove
  onClose: () => void
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const changed = useChanged(view.id)
  const apply = useMutation(
    trpc.mods.changePack.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        void queries.invalidateQueries({ queryKey: trpc.mods.list.queryKey({ serverId: view.id }) })
        onClose()
      },
    }),
  )
  const send = (requestId: string, acknowledgeRevoked: boolean) =>
    apply.mutateAsync({
      serverId: view.id,
      requestId,
      version: view.version,
      to: move.to,
      acknowledgeRevoked,
    })
  const from = list.modpack
  return (
    <ConfirmChange
      open
      onClose={onClose}
      title={`Play ${move.name} ${move.version}?`}
      lines={[
        `${from?.name ?? 'Pack'} ${from?.version ?? ''} → ${move.name} ${move.version}`.replace(/ +/g, ' '),
        ...(move.movesWorld ? [`Minecraft ${list.gameVersion} → ${move.gameVersion}`] : []),
      ]}
      confirmLabel={view.status === 'running' ? 'Update and restart' : 'Update'}
      working="Updating the pack"
      error={apply.error}
      onConfirm={(requestId) => send(requestId, false)}
      onAcknowledge={(requestId) => send(requestId, true)}
    >
      {move.movesWorld && (
        <Note tone="info">
          The world moves to Minecraft {move.gameVersion}, and a world never moves back. Everyone playing
          needs the new version too.
        </Note>
      )}
      <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
        {view.status === 'running'
          ? 'Cubepals keeps a copy of the world first, and if the new version doesn’t start, the server goes back to this one by itself.'
          : 'It installs the next time the server starts, with a copy of the world kept first: if the new version doesn’t start, the server goes back to this one by itself.'}
      </p>
    </ConfirmChange>
  )
}

/** A list of names as a sentence reads it: "A, B, C and 4 more". */
function someOf(names: readonly string[]): string {
  if (names.length <= 4)
    return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

export default function ModsPage() {
  const server = useServer()
  const trpc = useTRPC()
  const mods = useQuery(trpc.mods.list.queryOptions({ serverId: server.id }))
  const [pending, setPending] = useState<{ title: string; change: Change } | null>(null)

  if (server.isPending || mods.isPending) return <PageSkeleton sections={[3]} />
  if (server.isError) return <LoadFailed error={messageOf(server.error)} onRetry={() => server.refetch()} />
  if (mods.isError) return <LoadFailed error={messageOf(mods.error)} onRetry={() => mods.refetch()} />
  const view = server.data
  const list = mods.data
  const noun = list.kind === 'plugins' ? 'Plugins' : list.kind === 'datapacks' ? 'Datapacks' : 'Mods'

  return (
    <>
      <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
        {noun}
      </h1>
      {list.modpack !== null ? (
        <PlayingAPack view={view} list={list} />
      ) : list.kind === null ? (
        <EmptyState
          title={`Minecraft ${list.gameVersion} runs no ${noun.toLowerCase()} yet`}
          description="Cubepals offers no server type that runs them on this release. Move the world to another version and they are back."
          action={
            <Button variant="primary" href={`/servers/${view.id}/settings#version`}>
              Change version
            </Button>
          }
        />
      ) : (
        <>
          <ChangeState view={view} />
          <Installed view={view} list={list} onChange={setPending} />
          <Search view={view} list={list} onChange={setPending} />
          {/* Uploads are jars; a server that takes only datapacks has nowhere to run one. */}
          {list.kind !== 'datapacks' && <Uploads view={view} list={list} onChange={setPending} />}
          {pending && (
            <PlanChange
              view={view}
              list={list}
              title={pending.title}
              change={pending.change}
              onClose={() => setPending(null)}
            />
          )}
        </>
      )}
    </>
  )
}

function Installed({
  view,
  list,
  onChange,
}: {
  view: ServerView
  list: ModsView
  onChange: (pending: { title: string; change: Change }) => void
}) {
  const noun = list.kind === 'plugins' ? 'plugins' : list.kind === 'datapacks' ? 'datapacks' : 'mods'
  const allowed = changeable(view)
  return (
    <FormSection
      title="On this server"
      description={
        list.switchesTo
          ? `Minecraft ${list.gameVersion}, plain for now. The first mod moves it to ${list.switchesTo.label}, world and all; datapacks keep it plain.`
          : `${loaderLabel(list.loader)} ${list.gameVersion}. Players need the ones marked for players too.`
      }
      actions={
        list.mods.some((m) => m.source === 'catalog') ? (
          <Button
            variant="outline"
            icon={<RefreshCw {...ICON} aria-hidden />}
            busy={allowed.busy}
            disabled={!allowed.ok}
            onClick={() => onChange({ title: `Update ${noun}?`, change: { upgrade: 'all' } })}
          >
            Check for updates
          </Button>
        ) : undefined
      }
    >
      {list.mods.length === 0 ? (
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          No {noun} yet. Find some below.
        </p>
      ) : (
        list.mods.map((mod) => (
          <FormRow
            key={mod.id}
            label={
              <span className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
                {mod.name}
                <span className="type-mono-sm" style={{ color: 'var(--ink-muted)' }}>
                  {mod.versionLabel}
                </span>
                {mod.datapack && <Badge tone="neutral">Datapack</Badge>}
                {mod.environment === 'both' && <Badge tone="info">For players too</Badge>}
                {mod.revoked && <Badge tone="danger">Taken down</Badge>}
              </span>
            }
            description={describe(mod)}
            control={
              <div className="bk-row" style={{ gap: 'var(--space-8)' }}>
                {mod.url && (
                  <Button
                    variant="ghost"
                    size="sm"
                    href={mod.url}
                    iconEnd={<ExternalLink {...ICON} aria-hidden />}
                    aria-label={`${mod.name} on Modrinth`}
                  >
                    Modrinth
                  </Button>
                )}
                {mod.origin === 'user' && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!allowed.ok}
                    onClick={() => onChange({ title: `Remove ${mod.name}?`, change: { remove: [mod.id] } })}
                  >
                    Remove
                  </Button>
                )}
              </div>
            }
          />
        ))
      )}
    </FormSection>
  )
}

function describe(mod: ModView): string {
  if (mod.origin === 'dependency') return `Needed by ${mod.requiredBy.join(', ')}.`
  if (mod.source === 'upload') return 'Your upload.'
  return 'You added it.'
}

function Search({
  view,
  list,
  onChange,
}: {
  view: ServerView
  list: ModsView
  onChange: (pending: { title: string; change: Change }) => void
}) {
  const trpc = useTRPC()
  const [text, setText] = useState('')
  const settled = useDebounced(text.trim(), 300)
  const results = useQuery({
    ...trpc.mods.search.queryOptions({ serverId: view.id, text: settled }),
    placeholderData: (previous) => previous,
  })
  const allowed = changeable(view)
  const noun = list.kind === 'plugins' ? 'plugins' : list.kind === 'datapacks' ? 'datapacks' : 'mods'
  // On a plan that plays Minecraft as it comes, searching still works; adding one is where the
  // plan that runs them is offered, instead of a change that would only be refused.
  const overview = useQuery(trpc.account.overview.queryOptions())
  const entitlements = overview.data?.entitlements
  const plain =
    (list.kind === 'datapacks' ? entitlements?.mayUseDatapacks : entitlements?.mayUseMods) === false
  const [reached, setReached] = useState(false)
  return (
    <FormSection
      title={`Find ${noun}`}
      description={
        list.switchesTo
          ? `From Modrinth, for Minecraft ${list.gameVersion}. A mod moves this server to ${list.switchesTo.label} and keeps your world; a datapack keeps it plain.`
          : `From Modrinth, only ones with a version for ${loaderLabel(list.loader)} ${list.gameVersion}.`
      }
    >
      <TextField
        label="Search"
        placeholder={
          list.kind === 'plugins'
            ? 'EssentialsX, LuckPerms…'
            : list.kind === 'datapacks'
              ? 'Manhunt, Day Counter…'
              : 'Sodium, Lithium, Create…'
        }
        value={text}
        onChange={(event) => setText(event.target.value)}
        autoComplete="off"
      />
      {reached && (
        <PlusOffer
          why={list.kind === 'datapacks' ? 'Datapacks come with Plus.' : 'Mods and plugins come with Plus.'}
          reason="mods"
        />
      )}
      {results.isError && <Note tone="danger">{messageOf(results.error)}</Note>}
      {results.isPending ? (
        <Skeleton width="100%" height={120} />
      ) : (
        <div className="bk-list">
          {results.data?.hits.length === 0 && (
            <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
              Nothing on Modrinth by that name fits this server.
            </p>
          )}
          {results.data?.hits.map((hit) => (
            <FormRow
              key={hit.projectId}
              label={
                <span className="bk-row" style={{ gap: 'var(--space-12)' }}>
                  {hit.iconUrl ? (
                    <Image
                      src={hit.iconUrl}
                      alt=""
                      width={32}
                      height={32}
                      unoptimized
                      style={{ borderRadius: 6 }}
                    />
                  ) : null}
                  {hit.name}
                </span>
              }
              description={
                hit.runsOnServers ? (
                  <>
                    {hit.summary}
                    <br />
                    <span className="type-caption bk-num" style={{ color: 'var(--ink-muted)' }}>
                      <Download size={12} aria-hidden /> {downloads(hit.downloads)}
                    </span>
                  </>
                ) : (
                  hit.summary
                )
              }
              // Only found by its name: a server can't run it, and the row says so.
              why={hit.runsOnServers ? undefined : 'Made for your own game, not for a server'}
              control={
                hit.installed ? (
                  <Badge tone="grass">Added</Badge>
                ) : !hit.runsOnServers ? null : (
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<Plus {...ICON} aria-hidden />}
                    disabled={!allowed.ok}
                    onClick={() =>
                      plain
                        ? setReached(true)
                        : onChange({
                            title: `Add ${hit.name}?`,
                            change: { add: [{ projectId: hit.projectId }] },
                          })
                    }
                  >
                    Add
                  </Button>
                )
              }
            />
          ))}
        </div>
      )}
    </FormSection>
  )
}

/**
 * The owner's own jars: sent straight to the store, checked by the control plane, then added
 * like any mod. Earlier uploads can go on this server too, or be deleted once nothing runs them.
 */
function Uploads({
  view,
  list,
  onChange,
}: {
  view: ServerView
  list: ModsView
  onChange: (pending: { title: string; change: Change }) => void
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const uploads = useQuery(trpc.mods.uploads.queryOptions({ serverId: view.id }))
  const begin = useMutation(trpc.mods.beginUpload.mutationOptions())
  const finish = useMutation(trpc.mods.finishUpload.mutationOptions())
  const refresh = () =>
    queries.invalidateQueries({ queryKey: trpc.mods.uploads.queryKey({ serverId: view.id }) })
  const remove = useMutation(trpc.mods.deleteUpload.mutationOptions({ onSuccess: refresh }))
  const [sending, setSending] = useState<{ name: string; stage: string; done: number } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const allowed = changeable(view)
  const noun = list.kind === 'plugins' ? 'plugin' : 'mod'
  const installed = new Set(list.mods.map((m) => m.id))

  const upload = async (file: File) => {
    setFailure(null)
    try {
      setSending({ name: file.name, stage: 'Reading the file…', done: 0 })
      const sha512 = await sha512Of(file)
      const start = await begin.mutateAsync({
        serverId: view.id,
        fileName: file.name,
        sizeBytes: file.size,
        sha512,
      })
      let uploadId: string
      if (start.kind === 'upload') {
        await putFile(start.url, start.headers, file, (sent) =>
          setSending({ name: file.name, stage: 'Uploading…', done: (sent / file.size) * 100 }),
        )
        setSending({ name: file.name, stage: 'Checking it…', done: 100 })
        uploadId = (await finish.mutateAsync({ serverId: view.id, ticket: start.ticket })).uploadId
      } else uploadId = start.uploadId
      await refresh()
      onChange({ title: `Add ${file.name}?`, change: { addUploads: [uploadId] } })
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setSending(null)
    }
  }

  if (!list.uploads.available && list.uploads.code === 'deployment_unsupported') return null
  return (
    <FormSection
      title={`Your own ${noun}s`}
      description={`Upload a ${noun} you have as a .jar. Cubepals checks it runs on servers; it doesn't add what it needs, so add those from the search above.`}
      actions={
        <FileButton
          accept=".jar,application/java-archive"
          icon={<Upload {...ICON} aria-hidden />}
          disabled={!list.uploads.available || !allowed.ok || sending !== null}
          onFile={(file) => void upload(file)}
        >
          Upload a {noun}
        </FileButton>
      }
    >
      {!list.uploads.available && <Note tone="info">{list.uploads.message}</Note>}
      {sending && (
        <div className="bk-stack" style={{ gap: 'var(--space-8)' }}>
          <span className="type-body-sm">
            {sending.name}: {sending.stage}
          </span>
          <ProgressBar value={sending.done} label={`Uploading ${sending.name}`} />
        </div>
      )}
      {failure && <Note tone="danger">{failure}</Note>}
      {remove.isError && <Note tone="danger">{messageOf(remove.error)}</Note>}
      {uploads.isError && <Note tone="danger">{messageOf(uploads.error)}</Note>}
      {uploads.data?.length === 0 && (
        <p className="type-body" style={{ color: 'var(--ink-muted)' }}>
          Nothing uploaded yet.
        </p>
      )}
      {uploads.data?.map((upload) => (
        <FormRow
          key={upload.id}
          label={
            <span className="bk-row bk-wrap" style={{ gap: 'var(--space-8)' }}>
              {upload.name}
              <span className="type-mono-sm" style={{ color: 'var(--ink-muted)' }}>
                {upload.version}
              </span>
              {!upload.fits && <Badge tone="outline">For another version or server type</Badge>}
            </span>
          }
          description={[upload.fileName, bytes(upload.sizeBytes)].filter(Boolean).join(' · ')}
          control={
            <div className="bk-row" style={{ gap: 'var(--space-8)' }}>
              {!upload.inUse && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ serverId: view.id, uploadId: upload.id })}
                >
                  Delete
                </Button>
              )}
              {installed.has(`upload:${upload.id}`) ? (
                <Badge tone="grass">Added</Badge>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  icon={<Plus {...ICON} aria-hidden />}
                  disabled={!allowed.ok || !upload.fits}
                  onClick={() =>
                    onChange({ title: `Add ${upload.name}?`, change: { addUploads: [upload.id] } })
                  }
                >
                  Add
                </Button>
              )}
            </div>
          }
        />
      ))}
    </FormSection>
  )
}

const downloads = (count: number) =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(1)}M downloads`
    : count >= 1_000
      ? `${Math.round(count / 1_000)}K downloads`
      : `${count} downloads`

/** The change resolved against Modrinth and shown whole, dependencies and all, before it applies. */
function PlanChange({
  view,
  list,
  title,
  change,
  onClose,
}: {
  view: ServerView
  list: ModsView
  title: string
  change: Change
  onClose: () => void
}) {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const changed = useChanged(view.id)
  const [acknowledged, setAcknowledged] = useState(false)
  // The newer Minecraft the owner accepted, when the change didn't fit the one they run.
  const [moveTo, setMoveTo] = useState<string | null>(null)
  const plan = useQuery(
    trpc.mods.plan.queryOptions({
      serverId: view.id,
      ...change,
      ...(moveTo === null ? {} : { moveTo }),
    }),
  )
  const apply = useMutation(
    trpc.mods.change.mutationOptions({
      onSuccess: (next) => {
        changed(next)
        void queries.invalidateQueries({ queryKey: trpc.mods.list.queryKey({ serverId: view.id }) })
        void queries.invalidateQueries({ queryKey: trpc.mods.search.pathKey() })
        void queries.invalidateQueries({ queryKey: trpc.mods.uploads.queryKey({ serverId: view.id }) })
        onClose()
      },
    }),
  )
  const planned = plan.data?.kind === 'ok' ? plan.data : null
  const refused = plan.data?.kind === 'conflicts' ? plan.data : null
  const lines = planned ? presentPlan(planned) : []
  const send = (requestId: string, acknowledgeRevoked: boolean) =>
    apply.mutateAsync({
      serverId: view.id,
      ...change,
      ...(moveTo === null ? {} : { moveTo }),
      requestId,
      expected: planned?.expected ?? [],
      acknowledgeRevoked,
    })

  return (
    <ConfirmChange
      open
      onClose={onClose}
      title={planned && lines.length === 0 ? 'Everything is up to date' : title}
      lines={lines}
      confirmLabel={view.status === 'running' ? 'Apply and restart' : 'Apply'}
      working="Applying your mods"
      error={apply.error}
      disabled={planned === null || lines.length === 0 || (planned.revoked.length > 0 && !acknowledged)}
      onConfirm={(requestId) => send(requestId, acknowledged)}
      onAcknowledge={(requestId) => send(requestId, true)}
    >
      {plan.isPending && <Skeleton width="70%" />}
      {plan.isError && <Note tone="danger">{messageOf(plan.error)}</Note>}
      {refused !== null && (
        <>
          <Note tone="danger">
            Nothing changes, because:
            <ul style={{ paddingLeft: 'var(--space-20)' }}>
              {refused.conflicts.map((conflict) => (
                <li key={JSON.stringify(conflict)}>{presentConflict(conflict, list)}</li>
              ))}
            </ul>
          </Note>
          {/* Where a newer Minecraft would work, Blockly says so and offers the move, once. */}
          {refused.movesTo !== null && (
            <Note tone="info">
              It works on Minecraft {refused.movesTo.gameVersion}. Cubepals can move this world there and
              install it in the same change — your world comes along, and a world never moves back.
              <div style={{ marginBlockStart: 'var(--space-12)' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setMoveTo(refused.movesTo?.gameVersion ?? null)}
                >
                  Move to {refused.movesTo.gameVersion} and install
                </Button>
              </div>
            </Note>
          )}
        </>
      )}
      {planned && planned.revoked.length > 0 && (
        <RevokedChoice
          mods={planned.revoked.map((m) => m.name)}
          checked={acknowledged}
          onChange={setAcknowledged}
        />
      )}
      {planned && lines.length > 0 && (
        <p className="type-body-sm" style={{ color: 'var(--ink-muted)' }}>
          {moveTo !== null && (
            <>This world moves to Minecraft {moveTo}, which is where these run. It doesn’t move back. </>
          )}
          {planned.loader !== list.loader && planned.added.length > 0 && (
            <>
              This server moves from Vanilla to {loaderLabel(planned.loader)} to run{' '}
              {planned.added.length === 1 ? 'it' : 'them'}. Your world comes along.{' '}
            </>
          )}
          {datapacksSaid(planned.added)}
          {planned.added.some((m) => m.environment === 'both') &&
            'Players need the ones marked for players too in their own game. '}
          {whatHappens(view)}
        </p>
      )}
    </ConfirmChange>
  )
}
