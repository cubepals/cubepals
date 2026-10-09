/**
 * Finding a modpack to play on the create-server page: by search, by a pasted link, and at which
 * of its versions. It does not check whether a pack can be made or create anything: it hands the
 * pick to the page, which does both.
 */
import type { ModpackHit, PackLinkView, PlanFit } from '@blockly/contracts'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { messageOf, useTRPC } from '../../../../lib/api'
import { useDebounced } from '../../../../lib/hooks'
import { Note, Select, Skeleton, TextField } from '../../../../ui'
import styles from './create.module.css'
import { packPicture, Thumb } from './thumb'

/** Whether a paid plan runs what this plan doesn't: then it can be chosen, with that plan offered. */
export const paidFor = (fits: PlanFit): boolean => !fits.allowed && fits.plan !== null

/**
 * Whether the next thing is typing, on a keyboard that is already there. On a phone, focusing a
 * field raises the keyboard over the page the moment a question opens, so there it waits for a tap.
 */
export const typingNext = (): boolean => window.matchMedia('(pointer: fine)').matches

/**
 * Looking for a pack by name. Nothing here asks about Minecraft versions or loaders: a pack
 * brings both, and the bar says what they turned out to be.
 */
export function Modpacks({
  picked,
  pickedVersion,
  checking,
  refused,
  offer,
  disabled,
  onPick,
  onHaveFile,
}: {
  picked: string | null
  /** The version picked, where it isn't simply the newest. */
  pickedVersion: string | null
  checking: string | null
  /** Why the last pack they chose can't be made, in Blockly's words, said under that pack. */
  refused: { key: string; message: string } | null
  /** The plan that runs the pack picked, offered under it. */
  offer: ReactNode
  disabled: boolean
  onPick: (hit: ModpackHit, versionId?: string) => void
  /** They have the pack as a file instead. */
  onHaveFile: () => void
}) {
  const trpc = useTRPC()
  const [text, setText] = useState('')
  const settled = useDebounced(text.trim(), 300)
  // A link pasted where a name is typed is the pack it points at, or what to do instead.
  const link = /^https?:\/\//i.test(settled) ? settled : null
  const linked = useQuery({
    ...trpc.servers.packFromLink.queryOptions({ url: link ?? 'https://' }),
    enabled: link !== null,
  })
  // Opening the packs is for searching them; on a phone the list comes first, not the keyboard.
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (typingNext()) field.current?.focus()
  }, [])
  const searching = settled.length >= 2 && link === null
  // An empty search is the catalogue's own most-played packs, which is a better first screen
  // than a blank one: nobody should have to know a pack's name before Blockly will help.
  const packs = useQuery({
    ...trpc.servers.searchModpacks.queryOptions({ text: searching ? settled : '', limit: 8, offset: 0 }),
    placeholderData: (previous) => previous,
  })
  const found = link === null ? (packs.data ?? []) : []
  const versionRow = (hit: ModpackHit) =>
    picked === hit.projectId ? (
      <PackVersion
        projectId={hit.projectId}
        picked={pickedVersion}
        disabled={disabled || checking !== null}
        onPick={(versionId) => onPick(hit, versionId)}
      />
    ) : null
  return (
    <div className={styles.packs}>
      <TextField
        ref={field}
        label="Search modpacks"
        placeholder="Create, Cobblemon, Better MC…"
        leading={<Search size={18} strokeWidth={1.75} />}
        maxLength={100}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        // The search sits inside the page's form: Enter searches, it never creates the server.
        onKeyDown={(event) => event.key === 'Enter' && event.preventDefault()}
        help="Packs published on Modrinth, by name or by a link to one. Cubepals installs the whole thing: mods, settings and all."
      />
      {link !== null && linked.isPending && <Skeleton width="100%" height={88} />}
      {link !== null && linked.isError && <Note tone="danger">{messageOf(linked.error)}</Note>}
      {link !== null && linked.data?.kind === 'refused' && (
        <LinkRefused refused={linked.data} onHaveFile={onHaveFile} />
      )}
      {link !== null && linked.data?.kind === 'pack' && (
        <Pack
          hit={linked.data.hit}
          picked={picked === linked.data.hit.projectId}
          busy={checking === linked.data.hit.projectId}
          refused={refused?.key === linked.data.hit.projectId ? refused.message : null}
          offer={picked === linked.data.hit.projectId ? offer : null}
          disabled={disabled}
          onPick={() => {
            const data = linked.data
            if (data?.kind === 'pack') onPick(data.hit, data.versionId ?? undefined)
          }}
          below={versionRow(linked.data.hit)}
        />
      )}
      {packs.isPending && <Skeleton width="100%" height={88} />}
      {packs.isError && <Note tone="danger">{messageOf(packs.error)}</Note>}
      {searching && found.length === 0 && !packs.isPending && (
        // Search reaches Modrinth only. A pack that lives on CurseForge alone is still playable: its
        // server pack, downloaded from its CurseForge page, dropped here.
        <p className={`type-body-sm ${styles.quiet}`}>
          Nothing by that name here. Is it on CurseForge? Download its server pack from its page there, then{' '}
          <button type="button" className="bk-linkbutton" onClick={onHaveFile}>
            drop it here
          </button>
          .
        </p>
      )}
      {!searching && found.length > 0 && (
        <p className={`type-body-sm ${styles.quiet}`}>The ones most people are playing:</p>
      )}
      {found.map((hit) => (
        <Pack
          key={hit.projectId}
          hit={hit}
          picked={picked === hit.projectId}
          busy={checking === hit.projectId}
          refused={refused?.key === hit.projectId ? refused.message : null}
          offer={picked === hit.projectId ? offer : null}
          disabled={disabled}
          onPick={() => onPick(hit)}
          below={versionRow(hit)}
        />
      ))}
      <p className={`type-body-sm ${styles.quiet}`}>
        Have the pack as a file?{' '}
        <button type="button" className="bk-linkbutton" onClick={onHaveFile}>
          Drop it in instead
        </button>
        .
      </p>
    </div>
  )
}

/**
 * A pasted link Blockly can't make a server of, and the way that works instead: a CurseForge
 * pack's own files page, where its server pack is downloaded, then the file dropped here.
 */
function LinkRefused({
  refused,
  onHaveFile,
}: {
  refused: Extract<PackLinkView, { kind: 'refused' }>
  onHaveFile: () => void
}) {
  return (
    <Note tone="info">
      {refused.message}{' '}
      {refused.page !== null && (
        <>
          <a href={refused.page} target="_blank" rel="noreferrer">
            Open its files
          </a>{' '}
          ·{' '}
        </>
      )}
      <button type="button" className="bk-linkbutton" onClick={onHaveFile}>
        Drop a file
      </button>
    </Note>
  )
}

/**
 * Which version of a pack the server plays: the newest a server can run unless they pick another,
 * because friends who already have an older one installed play on that. Only shown where there is
 * more than one to pick.
 */
function PackVersion({
  projectId,
  picked,
  disabled,
  onPick,
}: {
  projectId: string
  picked: string | null
  disabled: boolean
  onPick: (versionId: string) => void
}) {
  const trpc = useTRPC()
  const versions = useQuery(trpc.servers.packVersions.queryOptions({ projectId }))
  const all = versions.data ?? []
  if (all.length < 2) return null
  return (
    <div className={styles.version}>
      <Select
        label="Version"
        value={picked ?? all[0]?.versionId}
        disabled={disabled}
        onChange={(event) => onPick(event.target.value)}
        options={all.map((version, i) => ({
          value: version.versionId,
          label: `${version.label} · Minecraft ${version.gameVersion}${i === 0 ? ' · newest' : ''}`,
        }))}
      />
    </div>
  )
}

/**
 * One pack, as somebody scans a list of them: its own picture, its name, its own words, and
 * underneath, quietly, the two things people actually choose on — how many play it, and which
 * Minecraft it would be. A pack that can't be a server, or one Blockly has no release for, says
 * so instead of being a dead end.
 */
function Pack({
  hit,
  picked,
  busy,
  refused,
  offer,
  disabled,
  onPick,
  below,
}: {
  hit: ModpackHit
  picked: boolean
  busy: boolean
  refused: string | null
  offer: ReactNode
  disabled: boolean
  onPick: () => void
  /** What goes under it once picked: its version. */
  below?: ReactNode
}) {
  // Under the pack's own name, a refusal that begins with it reads on from it: "Leaves 34 of its
  // mods for each player to download by hand, …".
  const refusal = hit.refusal?.startsWith(`${hit.name} `)
    ? hit.refusal.charAt(hit.name.length + 1).toUpperCase() + hit.refusal.slice(hit.name.length + 2)
    : hit.refusal
  // What the plan can't run is still listed, dimmed, with the words choosing it would get.
  const why = !hit.runsOnServers
    ? 'Made for your own game, not for a server'
    : hit.gameVersion === null
      ? 'Not on a Minecraft Cubepals runs yet'
      : refusal !== null
        ? refusal
        : hit.fits.allowed
          ? null
          : hit.fits.reason
  // Only a pack another plan runs is picked past its reason; anything else stays out of reach.
  const paysFor = !hit.fits.allowed && why === hit.fits.reason && paidFor(hit.fits)
  return (
    <div>
      <button
        type="button"
        className={styles.row}
        aria-pressed={picked}
        aria-busy={busy || undefined}
        disabled={disabled || (why !== null && !paysFor)}
        onClick={onPick}
      >
        <Thumb picture={packPicture(hit)} state={busy ? 'busy' : picked ? 'picked' : undefined} />
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>{hit.name}</span>
          <span className={styles.rowBlurb}>{hit.summary}</span>
          <span className={why === null ? styles.rowMeta : styles.rowWhy}>
            {why ?? `${plays(hit.downloads)} · Minecraft ${hit.gameVersion}`}
          </span>
        </span>
      </button>
      {below}
      {refused !== null && (
        <p className={`type-body-sm ${styles.refused}`} role="alert">
          {refused}
        </p>
      )}
      {offer}
    </div>
  )
}

/** How many have played it, in the shape people read at a glance: "1.8M downloads". */
const plays = (downloads: number): string =>
  `${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(downloads)} downloads`
