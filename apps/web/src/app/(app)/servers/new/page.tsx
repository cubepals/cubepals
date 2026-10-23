// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import {
  type ModpackHit,
  type PartySize,
  type SetupPreview,
  type SetupSourceInput,
  TEMPLATE_CARDS,
  type TemplateCard,
  versionsThatJoin,
} from '@blockly/contracts'
import { noop, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  type SubmitEvent,
  Suspense,
  useEffect,
  useRef,
  useState,
} from 'react'
import { codeOf, messageOf, useTRPC } from '../../../../lib/api'
import { useDebounced } from '../../../../lib/hooks'
import { iconSrc } from '../../../../lib/present'
import * as rules from '../../../../lib/rules'
import { useChecked } from '../../../../lib/use-checked'
import { Button, JavaAndBedrock, Note, OutLink, Skeleton, TextField, Toggle } from '../../../../ui'
import { PackDrop, type ReadPack } from '../../pack-drop'
import { PlusOffer } from '../../plus-offer'
import { useChoosing } from './choosing'
import styles from './create.module.css'
import { keptChoice, keptPath } from './kept'
import { usePlanLimit } from './limit'
import { Modpacks, typingNext } from './modpacks'
import { Part } from './part'
import { previewQuery, useChoicesAhead } from './preview'
import { useRegion } from './region'
import { ReleasePick } from './release'
import { useCreate } from './sending'
import { createMark, useSteps } from './steps'
import { curatedPicture, type Picture, packPicture, Thumb, wayPicture } from './thumb'
import { Ways } from './ways'

/**
 * Making a server is three questions on one page. The first is what to play, which decides the
 * Minecraft version, the server type, the mods and the size the server needs; the second is who
 * is playing, asked only where the plan sells more than one size; the third is the name. Each
 * answer opens the next question, and a bar that stays in view says what is being made and holds
 * the one button that makes it. Nothing here asks about any of what the first answer settled.
 */
export default function CreateServerPage() {
  return (
    <Suspense fallback={null}>
      <CreateServer />
    </Suspense>
  )
}

function CreateServer() {
  const trpc = useTRPC()
  const queries = useQueryClient()
  const search = useSearchParams()
  const options = useQuery(trpc.servers.createOptions.queryOptions())
  // "A modpack" opens on the most-played list: fetched with the page, so it's there on the click.
  useEffect(() => {
    queries.query(trpc.servers.searchModpacks.queryOptions({ text: '', limit: 8, offset: 0 })).catch(noop)
  }, [queries, trpc])
  // "Make one like this" arrives as a link: the server to copy, and the invite that let its
  // friend see it. What to play is answered by the link.
  const like = search.get('like')
  const invite = search.get('invite')
  // Back from paying for what they chose: the choice, the group and the name, as they left them.
  const [kept] = useState(() => keptChoice(search))
  const [from, setFrom] = useState<SetupSourceInput | null>(
    like === null ? kept.from : { kind: 'server', slug: like, ...(invite === null ? {} : { invite }) },
  )
  // A server whose first build failed, being made again: the page opens on the packs when it
  // failed on its pack, keeps its name, and the new one takes its place and its address.
  const replace = search.get('replace')
  const replacing = useQuery({
    ...trpc.servers.get.queryOptions({ serverId: replace ?? '' }),
    enabled: replace !== null,
  })
  const [picking, setPicking] = useState<'ways' | 'packs' | 'upload'>(
    kept.from?.kind === 'modpack' ? 'packs' : kept.from?.kind === 'import' ? 'upload' : 'ways',
  )
  // The pack picked, as its list showed it: its name and picture stand for the choice.
  const [pack, setPack] = useState<ModpackHit | null>(null)
  // A pack they have as a file, once Blockly has read it.
  const [ownPack, setOwnPack] = useState<ReadPack | null>(null)
  const [partySize, setPartySize] = useState<PartySize | null>(kept.partySize)
  const region = useRegion(options.data?.regions, kept.region)
  const [name, setName] = useState('')
  // How long they want it is the one thing only they know; a game played in an evening starts out
  // as lasting a day until they say otherwise. Null: they haven't said.
  const [temporary, setTemporary] = useState<boolean | null>(null)
  const debouncedName = useDebounced(name.trim(), 300)
  const checkedName = useChecked(rules.serverName, name)

  const replacedName = replacing.data?.name
  const replacedPack = replacing.data?.failure?.remedy === 'modpack'
  useEffect(() => {
    if (replacedName !== undefined) setName((typed) => (typed === '' ? replacedName : typed))
    if (replacedPack) setPicking('packs')
  }, [replacedName, replacedPack])

  // The address said under the name stays put while the name does: a taken one's free
  // alternative is picked at random, and creating checks the one shown again anyway.
  const suggestion = useQuery({
    ...trpc.servers.suggestAddress.queryOptions({ name: debouncedName }),
    enabled: debouncedName.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: (previous) => previous,
  })
  const create = useCreate((input) => {
    setFrom(input.from ?? null)
    setPartySize(input.partySize)
    setName(input.name)
    setTemporary(input.temporary ?? null)
    if (input.regionKey !== undefined) region.choose(input.regionKey)
  })

  const sizes = options.data?.partySizes ?? []
  const choosable = sizes.filter((size) => size.allowed)
  const asksSize = choosable.length > 1
  const chosenSize = asksSize ? partySize : (choosable[0]?.value ?? null)
  // Until they say who is playing, a choice is judged at the smallest size: whether the plan
  // runs it at all.
  const judgedAt = chosenSize ?? choosable[0]?.value ?? '5'
  // A failed create's message is about the last press; changing anything moves on from it.
  const moveOn = () => {
    if (create.isError) create.reset()
  }
  const { choose, checking, refused, setRefused } = useChoosing({ from, setFrom, judgedAt, moveOn })

  // What Blockly would make of the choice, asked once and used twice: to refuse a choice that
  // can't run before anyone goes any further, and to say what the server will be in the bar.
  const preview = useQuery({
    ...previewQuery(trpc, from ?? { kind: 'template', key: 'survival' }, judgedAt),
    enabled: from !== null,
    placeholderData: (previous) => previous,
  })
  // Packs Blockly offers by name, each at the release a new server plays.
  const curated = options.data?.packs ?? []
  // Nothing chosen, nothing blocked: the preview keeps its last answer while it waits for a choice.
  const blocked =
    from !== null && preview.data?.size.allowed === false ? (preview.data.size.reason ?? null) : null

  // What the plan leaves out is shown, dimmed, with why — never hidden, and never found out only
  // after a click. Each answer is the one creating would give: the account's own verdict on
  // another server, and each template's fit, which the control plane works out as a preview does
  // and sends usable first.
  const { atLimit, limitCode, moreServers } = usePlanLimit(replace)
  // Where people stop: what they chose and what stood in the way, never what they typed.
  const page = useSteps({ from, partySize, region: region.picked, name, temporary, preview, refused, create })

  // A question opens once the ones before it are answered, and not before the page knows
  // whether it asks who is playing at all.
  const sizeOpen = options.data !== undefined && from !== null
  // A choice another plan runs holds the page where it was made, with that plan offered there.
  const nameOpen = sizeOpen && chosenSize !== null && blocked === null
  const sizePart = useRef<HTMLElement>(null)
  const namePart = useRef<HTMLElement>(null)
  const nameField = useRef<HTMLInputElement>(null)
  // Answering moves the page on to the next question, as a step would, without leaving it.
  useEffect(() => {
    if (sizeOpen) reveal(sizePart.current)
  }, [sizeOpen])
  useEffect(() => {
    if (!nameOpen) return
    if (typingNext()) nameField.current?.focus({ preventScroll: true })
    reveal(namePart.current)
  }, [nameOpen])

  // Back from the packs, the keyboard lands where it left: on "A modpack".
  const modpackWay = useRef<HTMLButtonElement>(null)
  const [cameBack, setCameBack] = useState(false)
  useEffect(() => {
    if (cameBack && picking === 'ways') modpackWay.current?.focus()
  }, [cameBack, picking])

  // A version someone picked stays theirs as they look through the templates.
  const [version, setVersion] = useState<string | undefined>(() =>
    from?.kind === 'template' ? from.gameVersion : undefined,
  )
  useChoicesAhead({ live: options.data, partySize: judgedAt, version, offers: like === null })
  const pickTemplate = (key: string) =>
    void choose({ kind: 'template', key, ...(version === undefined ? {} : { gameVersion: version }) }, key)
  const pickVersion = async (value: string) => {
    if (from?.kind !== 'template') return
    if (await choose({ ...from, gameVersion: value }, from.key)) setVersion(value)
  }
  const pickPack = async (hit: ModpackHit, versionId?: string) => {
    const source: SetupSourceInput = {
      kind: 'modpack',
      projectId: hit.projectId,
      ...(versionId === undefined ? {} : { versionId }),
    }
    if (await choose(source, hit.projectId)) setPack(hit)
  }
  const pickCurated = (key: string) => void choose({ kind: 'curated', key }, `curated:${key}`)
  const pickOwnPack = async (read: ReadPack) => {
    setOwnPack(read)
    await choose({ kind: 'import', importId: read.importId }, read.importId)
  }

  // A template's name and picture are the same for everyone, so the bar says them without waiting.
  const template = from?.kind === 'template' ? TEMPLATE_CARDS.find((one) => one.key === from.key) : undefined
  const forADay = temporary ?? template?.forADay === true
  const curatedPick = from?.kind === 'curated' ? curated.find((one) => one.key === from.key) : undefined
  const picked = from?.kind === 'modpack' ? pack : null
  const copying = from?.kind === 'server' ? (preview.data?.copying ?? null) : null
  const players = sizes.find((size) => size.value === chosenSize)?.maxPlayers
  const picture: Picture =
    template !== undefined
      ? wayPicture(template.icon)
      : curatedPick !== undefined
        ? curatedPicture(curatedPick)
        : picked !== null
          ? packPicture(picked)
          : from?.kind === 'modpack'
            ? wayPicture('modpack')
            : from?.kind === 'import'
              ? wayPicture('ownpack')
              : { src: iconSrc(copying?.icon ?? null) }
  // What is being made, as the bar says it: "Survival · Minecraft 26.3 · Up to 10 players". A
  // template's release is the newest it runs on unless someone picks another here, to match the
  // game their friends have; a pack's or a copy's is its own.
  const gameVersions = options.data?.gameVersions ?? []
  const release =
    preview.data === undefined ? null : from?.kind === 'template' && gameVersions.length > 0 ? (
      <ReleasePick
        template={from.key}
        title={template?.title}
        value={from.gameVersion ?? preview.data.gameVersion}
        offered={gameVersions}
        onPick={(value) => void pickVersion(value)}
      />
    ) : (
      `Minecraft ${preview.data.gameVersion}`
    )
  const summary: ReactNode[] =
    from === null
      ? ['Pick what to play']
      : [
          template?.title ??
            curatedPick?.way?.title ??
            curatedPick?.name ??
            picked?.name ??
            (from.kind === 'import' ? ownPack?.pack.name : undefined) ??
            (copying !== null ? `Like ${copying.name}` : preview.data?.from),
          ...withEditions(release, preview.data),
          region.said,
          chosenSize !== null && players !== undefined && `Up to ${players} players`,
          forADay && 'For a day',
        ].filter(Boolean)
  // A template's own line already says what it comes with; a pack or a copy says it here.
  const said =
    from === null || preview.data === undefined ? null : explain(preview.data, from, gameVersions, version)
  // Where the choice was made: the pack search, the drop, or the list of ways.
  const madeIn = from?.kind === 'modpack' ? 'packs' : from?.kind === 'import' ? 'upload' : 'ways'

  const ready =
    from !== null && chosenSize !== null && name.trim() !== '' && blocked === null && !preview.isError
  const offeredBy = preview.data?.size.allowed === false ? (preview.data.size.plan ?? null) : null
  const offer =
    blocked === null ? null : offeredBy === null ? (
      <Note tone="info">{blocked}</Note>
    ) : (
      <PlusOffer
        why={blocked}
        plan={offeredBy}
        reason={
          from?.kind === 'modpack' || from?.kind === 'import' || from?.kind === 'curated'
            ? 'modpack'
            : (preview.data?.mods.length ?? 0) > 0 ||
                !['vanilla', 'paper'].includes(preview.data?.loader ?? '')
              ? 'mods'
              : 'players'
        }
        next={keptPath(from, chosenSize, region.picked)}
        {...(like === null
          ? {
              instead: {
                label: 'Choose plain Minecraft instead',
                onClick: () => {
                  moveOn()
                  setFrom(null)
                  setPack(null)
                  setOwnPack(null)
                  setPicking('ways')
                },
              },
            }
          : {})}
      />
    )
  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (!checkedName.check() || !ready || from === null || chosenSize === null) return
    create.send({
      name: name.trim(),
      from,
      partySize: chosenSize,
      regionKey: region.key,
      ...(forADay ? { temporary: true } : {}),
      ...(replace !== null
        ? { replaces: replace }
        : suggestion.data?.available
          ? { slug: suggestion.data.slug }
          : {}),
    })
  }

  return (
    <form ref={page} className={styles.page} onSubmit={submit}>
      <h1 className={`type-display-md bk-enter ${styles.title}`}>Create a server</h1>

      {replacing.data && (
        <Note tone="info">
          This takes the place of {replacing.data.name}, which never started. It goes to the trash, and the
          new server keeps its address.
        </Note>
      )}
      {atLimit !== null &&
        (limitCode === 'limit_reached' && moreServers !== undefined ? (
          <PlusOffer
            why={`${atLimit} More come with ${moreServers.key[0]?.toUpperCase()}${moreServers.key.slice(1)}.`}
            plan={moreServers.key}
            reason="servers"
            next="/servers/new"
          />
        ) : (
          <Note tone="info">{atLimit}</Note>
        ))}

      <Part index={1} title="What to play" open done={from !== null}>
        {like !== null ? (
          // A friend's server, copied: the one answer there is, pictured as its page shows it.
          preview.isPending ? (
            <Skeleton width="100%" height={74} />
          ) : copying !== null ? (
            <div className={styles.row} data-picked>
              <Thumb picture={picture} state="picked" />
              <span className={styles.rowText}>
                <span className={styles.rowTitle}>{copying.name}</span>
                <span className={styles.rowBlurb}>
                  The same Minecraft{preview.data?.mods.length ? ' and mods' : ''}, with a world of your own.
                </span>
              </span>
            </div>
          ) : null
        ) : picking === 'packs' ? (
          <div key="packs" className={styles.swap}>
            <BackToWays
              onBack={() => {
                setRefused(null)
                setCameBack(true)
                setPicking('ways')
              }}
            />
            <Modpacks
              picked={picked?.projectId ?? (from?.kind === 'modpack' ? from.projectId : null)}
              pickedVersion={from?.kind === 'modpack' ? (from.versionId ?? null) : null}
              checking={checking}
              refused={refused}
              offer={asksSize ? null : offer}
              disabled={atLimit !== null}
              onPick={(hit, versionId) => void pickPack(hit, versionId)}
              onHaveFile={() => {
                setRefused(null)
                setPicking('upload')
              }}
            />
          </div>
        ) : picking === 'upload' ? (
          <div key="upload" className={styles.swap}>
            <BackToWays
              onBack={() => {
                setRefused(null)
                setCameBack(true)
                setPicking('ways')
              }}
            />
            <PackDrop
              disabled={atLimit !== null}
              onStart={() => {
                setOwnPack(null)
                if (from?.kind === 'import') setFrom(null)
              }}
              onReady={pickOwnPack}
            />
            {ownPack !== null && (
              <div className={styles.row} data-picked={from?.kind === 'import' || undefined}>
                <Thumb
                  picture={wayPicture('ownpack')}
                  state={
                    checking === ownPack.importId ? 'busy' : from?.kind === 'import' ? 'picked' : undefined
                  }
                />
                <span className={styles.rowText}>
                  <span className={styles.rowTitle}>{ownPack.pack.name}</span>
                  <span className={styles.rowBlurb}>
                    {[
                      ownPack.pack.version,
                      `Minecraft ${ownPack.pack.gameVersion}`,
                      `${ownPack.pack.mods} mods`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </div>
            )}
            {refused !== null && refused.key === ownPack?.importId && (
              <Note tone="info">{refused.message}</Note>
            )}
            {!asksSize && offer}
          </div>
        ) : (
          <div key="ways" className={styles.swap}>
            <Ways
              live={options.data}
              from={from}
              checking={checking}
              locked={atLimit !== null}
              modpackLine={picked?.name ?? (from?.kind === 'modpack' ? preview.data?.from : undefined)}
              ownPackLine={from?.kind === 'import' ? ownPack?.pack.name : undefined}
              modpackRef={modpackWay}
              onTemplate={pickTemplate}
              onCurated={pickCurated}
              onModpacks={() => {
                setRefused(null)
                setPicking('packs')
              }}
              onOwnPack={() => {
                setRefused(null)
                setPicking('upload')
              }}
            />
            {options.isError && <Note tone="danger">{messageOf(options.error)}</Note>}
            {refused !== null && <Note tone="info">{refused.message}</Note>}
          </div>
        )}
        {/* What Blockly makes of the choice, where it says more than the choice's own name. */}
        {said && picking === madeIn && (
          <p key={said} className={`type-body-sm ${styles.said}`}>
            {said}
          </p>
        )}
        {preview.isError && <PreviewFailed error={preview.error} said={refused?.message} />}
        {!asksSize && picking === 'ways' && madeIn === 'ways' && offer}
      </Part>

      {asksSize && (
        <Part ref={sizePart} index={2} title="Who’s playing" open={sizeOpen} done={partySize !== null}>
          <fieldset className="bk-chips">
            <legend className="bk-visually-hidden">How many play at once</legend>
            {sizes.map((size) => (
              <label key={size.value} className="bk-chip bk-num" title={size.reason}>
                <input
                  type="radio"
                  name="party-size"
                  value={size.value}
                  checked={partySize === size.value}
                  disabled={!size.allowed}
                  onChange={() => {
                    moveOn()
                    setPartySize(size.value)
                  }}
                />
                {size.label}
              </label>
            ))}
          </fieldset>
          <p className={`type-body-sm ${styles.quiet}`}>
            How many friends play at once. Bigger groups get a bigger server.
            {sizes.some((size) => !size.allowed) && ' Bigger groups than these need a bigger plan.'}
          </p>
          {offer}
        </Part>
      )}

      <Part ref={namePart} index={asksSize ? 3 : 2} title="Name it" open={nameOpen} done={false}>
        <TextField
          ref={nameField}
          label="Server name"
          placeholder="Sunset Valley"
          maxLength={40}
          required
          autoComplete="off"
          spellCheck={false}
          value={name}
          error={checkedName.error}
          onChange={(event) => {
            moveOn()
            setName(event.target.value)
          }}
          {...checkedName.field}
          help={
            replacing.data || suggestion.data?.joinAddress ? (
              <>
                Friends join at{' '}
                <span className="type-mono-md" style={{ color: 'var(--ink)' }} translate="no">
                  {replacing.data?.joinAddress ?? suggestion.data?.joinAddress}
                </span>
              </>
            ) : (
              'Players will use this to find your server.'
            )
          }
        />
        <div className={styles.temporary}>
          <Toggle
            checked={forADay}
            onChange={(next) => {
              moveOn()
              setTemporary(next)
            }}
            label="Just for a day"
          />
          <p className={`type-body-sm ${styles.quiet}`}>{lasting(temporary, template)}</p>
        </div>
      </Part>

      {/* The server as it will be, and the one button that makes it; a create that fails says
          why here, where the button was pressed. */}
      <div
        className={`bk-enter ${styles.bar}`}
        style={{ '--i': asksSize ? 4 : 3 } as CSSProperties}
        data-failed={create.isError || undefined}
      >
        <Thumb key={picture.src} picture={picture} />
        <span className={styles.barText}>
          <span className={styles.barName} data-empty={name.trim() === '' || undefined}>
            {name.trim() || 'Your server'}
          </span>
          {create.isError ? (
            <span className={styles.barFailure} role="alert">
              <AlertTriangle size={16} strokeWidth={1.75} aria-hidden />
              {messageOf(create.error)}
            </span>
          ) : (
            <span className={styles.barMeta}>
              {summary.map((part, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the parts keep their order
                <Fragment key={i}>
                  {i > 0 && ' · '}
                  {part}
                </Fragment>
              ))}
            </span>
          )}
        </span>
        <Button
          type="submit"
          variant="primary"
          disabled={!ready}
          busy={create.isPending ? 'Creating your server' : undefined}
          done={create.isSuccess ? 'Created' : undefined}
        >
          Create server
        </Button>
      </div>
      <p className={`type-caption ${styles.quiet}`}>
        Every server runs Minecraft under Mojang’s{' '}
        <OutLink className="bk-link" href="https://www.minecraft.net/eula">
          End User License Agreement
        </OutLink>
        .
      </p>
    </form>
  )
}

/** The way back from the packs or the upload to the list of ways to play. */
/** The bar's release, and "Java and Bedrock" after it where Bedrock friends join what is being made. */
const withEditions = (release: ReactNode, preview: SetupPreview | undefined): ReactNode[] =>
  preview?.bedrock ? [release, <JavaAndBedrock key="editions" />] : [release]

function BackToWays({ onBack }: { onBack: () => void }) {
  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        icon={<ArrowLeft size={16} strokeWidth={1.75} aria-hidden />}
        onClick={onBack}
        {...createMark('ways_back')}
      >
        Other ways to play
      </Button>
    </div>
  )
}

/** Brings a question that just opened into view, gently unless less motion was asked for. */
function reveal(part: HTMLElement | null) {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  part?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'nearest' })
}

/**
 * What "Just for a day" means as it stands: what they chose, or else what their way to play
 * suggests, and then Blockly says it chose it, with the toggle as the way back.
 */
function lasting(chosen: boolean | null, template: TemplateCard | undefined): string {
  if (!(chosen ?? template?.forADay))
    return 'For an evening with friends or a modpack you want to try. Cubepals clears it up afterwards.'
  const why = chosen === null ? `${template?.title} is played in an evening, so this one lasts a day. ` : ''
  return `${why}Cubepals deletes it 24 hours from now. Its world goes to the trash, and one press keeps it instead.`
}

/**
 * What Blockly makes of a choice, in a sentence, where there is something to say that its name
 * doesn't. For a template, what `templateLine` says; a template's own line says what it comes
 * with. For a pack or a copy: that a pack comes whole, whether friends need it too, and the mods
 * that come along.
 */
function explain(
  preview: SetupPreview,
  from: SetupSourceInput,
  offered: readonly { value: string }[],
  /** The version someone picked; a template that came without it can't run on it. */
  version: string | undefined,
): string | null {
  if (from.kind === 'template') return templateLine(preview, from, offered, version)
  const pack = preview.modpack
  const installs =
    pack === null
      ? null
      : pack.environment === 'server'
        ? 'Cubepals installs the whole pack, and friends join with plain Minecraft.'
        : `Cubepals installs the whole pack. Everyone playing needs ${pack.name} ${pack.version} in their own game.`
  const mods =
    preview.mods.length === 0
      ? null
      : `It comes with ${preview.mods.slice(0, 3).join(', ')}${
          preview.mods.length > 3 ? ` and ${preview.mods.length - 3} more` : ''
        }.`
  const line = [installs, mods, ...(pack?.notes ?? [])].filter((part) => part !== null).join(' ')
  return line === '' ? null : line
}

/**
 * A template's choice in a sentence: the Minecraft it picked when that isn't the newest, and why,
 * and that newer Minecraft joins too where the server carries what lets it. Plain Minecraft is
 * picked where Bedrock friends join it, which is the reason where it is one.
 */
function templateLine(
  preview: SetupPreview,
  from: SetupSourceInput & { kind: 'template' },
  offered: readonly { value: string }[],
  version: string | undefined,
): string | null {
  const picked =
    from.gameVersion === undefined && version !== undefined
      ? `${preview.from} doesn’t run on Minecraft ${version}, so Cubepals picked ${preview.gameVersion}, the newest it runs on.`
      : from.gameVersion !== undefined || preview.gameVersion === offered[0]?.value
        ? null
        : preview.loader === 'vanilla' && preview.bedrock
          ? `Cubepals picked Minecraft ${preview.gameVersion}, the newest Bedrock friends can join.`
          : `Cubepals picked Minecraft ${preview.gameVersion}, the newest that everything in ${preview.from} runs on.`
  // On an older release, a friend on another Minecraft would wonder whether they can join.
  const newer = preview.joins.newer
    ? `Players on Minecraft ${versionsThatJoin(preview.gameVersion, preview.joins)} can join.`
    : null
  const line = [picked, newer].filter((part) => part !== null).join(' ')
  return line === '' ? null : line
}

/**
 * Why the preview failed, said once: not again under a pick that already said it, and as a
 * refusal where the choice can't run rather than as something gone wrong.
 */
function PreviewFailed({ error, said }: { error: unknown; said: string | undefined }) {
  const message = messageOf(error)
  if (message === said) return null
  const refusal = codeOf(error) === 'mods_conflict' || codeOf(error) === 'invalid_choice'
  return <Note tone={refusal ? 'info' : 'danger'}>{message}</Note>
}
