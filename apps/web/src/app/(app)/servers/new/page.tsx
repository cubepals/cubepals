'use client'

import {
  type ModpackHit,
  type PartySize,
  type SetupPreview,
  type SetupSourceInput,
  TEMPLATE_CARDS,
  type TemplateCard,
} from '@blockly/contracts'
import { noop, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
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
import { messageOf, useTRPC } from '../../../../lib/api'
import { useDebounced } from '../../../../lib/hooks'
import { newId } from '../../../../lib/ids'
import { iconSrc } from '../../../../lib/present'
import * as rules from '../../../../lib/rules'
import { useChecked } from '../../../../lib/use-checked'
import { Button, Note, Skeleton, TextField, Toggle } from '../../../../ui'
import { PackDrop, type ReadPack } from '../../pack-drop'
import { PlusOffer } from '../../plus-offer'
import styles from './create.module.css'
import { keptChoice, keptPath } from './kept'
import { Modpacks, typingNext } from './modpacks'
import { Part } from './part'
import { useRegion } from './region'
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
  const router = useRouter()
  const search = useSearchParams()
  const options = useQuery(trpc.servers.createOptions.queryOptions())
  // "A modpack" opens on the most-played list: fetched with the page, so it's there on the click.
  useEffect(() => {
    queries.query(trpc.servers.searchModpacks.queryOptions({ text: '', limit: 8, offset: 0 })).catch(noop)
  }, [queries, trpc])
  const [idempotencyKey] = useState(() => newId())
  // "Make one like this" arrives as a link: the server to copy, and the invite that let its
  // friend see it. What to play is answered by the link.
  const like = search.get('like')
  const invite = search.get('invite')
  // Back from paying for what they chose: the choice, the group and the name, as they left them.
  const [kept] = useState(() => keptChoice(search))
  const [from, setFrom] = useState<SetupSourceInput | null>(
    like === null ? kept.from : { kind: 'server', slug: like, ...(invite === null ? {} : { invite }) },
  )
  // A server whose first build failed on its pack, being made again with another: the page
  // opens on the packs, under the same name, and the new one takes its place and its address.
  const replace = search.get('replace')
  const replacing = useQuery({
    ...trpc.servers.get.queryOptions({ serverId: replace ?? '' }),
    enabled: replace !== null,
  })
  const [picking, setPicking] = useState<'ways' | 'packs' | 'upload'>(
    replace !== null || kept.from?.kind === 'modpack'
      ? 'packs'
      : kept.from?.kind === 'import'
        ? 'upload'
        : 'ways',
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
  // Why the last thing they picked can't be made, said where they picked it.
  const [refused, setRefused] = useState<{ key: string; message: string } | null>(null)
  // What is being checked before it counts as picked: a template's key or a pack's id.
  const [checking, setChecking] = useState<string | null>(null)
  const debouncedName = useDebounced(name.trim(), 300)
  const checkedName = useChecked(rules.serverName, name)

  const replacedName = replacing.data?.name
  useEffect(() => {
    if (replacedName !== undefined) setName((typed) => (typed === '' ? replacedName : typed))
  }, [replacedName])

  // The address said under the name stays put while the name does: a taken one's free
  // alternative is picked at random, and creating checks the one shown again anyway.
  const suggestion = useQuery({
    ...trpc.servers.suggestAddress.queryOptions({ name: debouncedName }),
    enabled: debouncedName.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: (previous) => previous,
  })
  const create = useMutation(
    trpc.servers.create.mutationOptions({ onSuccess: (server) => router.push(`/servers/${server.id}`) }),
  )

  const sizes = options.data?.partySizes ?? []
  const choosable = sizes.filter((size) => size.allowed)
  const asksSize = choosable.length > 1
  const chosenSize = asksSize ? partySize : (choosable[0]?.value ?? null)
  // Until they say who is playing, a choice is judged at the smallest size: whether the plan
  // runs it at all.
  const judgedAt = chosenSize ?? choosable[0]?.value ?? '5'

  // What Blockly would make of the choice, asked once and used twice: to refuse a choice that
  // can't run before anyone goes any further, and to say what the server will be in the bar.
  const preview = useQuery({
    ...trpc.servers.setupPreview.queryOptions({
      from: from ?? { kind: 'template', key: 'survival' },
      partySize: judgedAt,
    }),
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
  const overview = useQuery(trpc.account.overview.queryOptions())
  const creating = overview.data?.features.find((f) => f.feature === 'create_server')
  // The server being replaced makes way first, so the plan's limit doesn't stand in the way.
  const atLimit = replace === null && creating?.available === false ? (creating.message ?? null) : null
  // A plan edge the person met here, where another plan would run it: a paid plan's own words,
  // said where the choice was made, and a way on without it.
  const limitCode = creating?.available === false ? creating.code : undefined
  const moreServers = overview.data?.plans.find(
    (p) => p.entitlements.maxServers > (overview.data?.entitlements.maxServers ?? 0),
  )

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

  // A failed create's message is about the last press; changing anything moves on from it.
  const moveOn = () => {
    if (create.isError) create.reset()
  }

  /**
   * Choosing something Blockly can't run is answered where the choice was made, not at a button
   * that does nothing. It is the question the bar asks too, so there is one rule about what fits
   * a plan, in one place, asked earlier.
   */
  const choose = async (source: SetupSourceInput, key: string): Promise<boolean> => {
    if (checking !== null) return false
    setChecking(key)
    setRefused(null)
    moveOn()
    try {
      const would = await queries.query(
        trpc.servers.setupPreview.queryOptions({ from: source, partySize: judgedAt }),
      )
      if (!would.size.allowed) {
        // What another plan runs stays chosen, with that plan offered under it; what no plan
        // runs is refused where it was picked.
        if (would.size.plan != null) {
          setFrom(source)
          return true
        }
        setRefused({ key, message: would.size.reason ?? 'That needs more power than your plan.' })
        return false
      }
      setFrom(source)
      return true
    } catch (error) {
      setRefused({ key, message: messageOf(error) })
      return false
    } finally {
      setChecking(null)
    }
  }
  // A version someone picked stays theirs as they look through the templates.
  const [version, setVersion] = useState<string | undefined>(() =>
    from?.kind === 'template' ? from.gameVersion : undefined,
  )
  const pickTemplate = (key: string) =>
    void choose({ kind: 'template', key, ...(version === undefined ? {} : { gameVersion: version }) }, key)
  const pickVersion = (value: string) => {
    setVersion(value)
    if (from?.kind === 'template') setFrom({ ...from, gameVersion: value })
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
      <select
        className={styles.barVersion}
        aria-label="Minecraft version"
        value={from.gameVersion ?? preview.data.gameVersion}
        onChange={(event) => pickVersion(event.target.value)}
      >
        {gameVersions.map((offered) => (
          <option key={offered.value} value={offered.value}>
            Minecraft {offered.label}
          </option>
        ))}
      </select>
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
          release,
          region.said,
          chosenSize !== null && players !== undefined && `Up to ${players} players`,
          forADay && 'For a day',
        ].filter(Boolean)
  // A template's own line already says what it comes with; a pack or a copy says it here.
  const said = from === null || preview.data === undefined ? null : explain(preview.data, from, gameVersions)
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
    create.mutate({
      idempotencyKey,
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
    <form className={styles.page} onSubmit={submit}>
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
            <div>
              <Button
                variant="ghost"
                size="sm"
                icon={<ArrowLeft size={16} strokeWidth={1.75} aria-hidden />}
                onClick={() => {
                  setRefused(null)
                  setCameBack(true)
                  setPicking('ways')
                }}
              >
                Other ways to play
              </Button>
            </div>
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
            <div>
              <Button
                variant="ghost"
                size="sm"
                icon={<ArrowLeft size={16} strokeWidth={1.75} aria-hidden />}
                onClick={() => {
                  setRefused(null)
                  setCameBack(true)
                  setPicking('ways')
                }}
              >
                Other ways to play
              </Button>
            </div>
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
        {preview.isError && <Note tone="danger">{messageOf(preview.error)}</Note>}
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
        <a className="bk-link" href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer">
          End User License Agreement
        </a>
        .
      </p>
    </form>
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
 * doesn't. For a template, the Minecraft it picked when that isn't the newest, and why; a
 * template's own line says what it comes with. For a pack or a copy: that a pack comes whole,
 * whether friends need it too, and the mods that come along.
 */
function explain(
  preview: SetupPreview,
  from: SetupSourceInput,
  offered: readonly { value: string }[],
): string | null {
  if (from.kind === 'template')
    return from.gameVersion !== undefined || preview.gameVersion === offered[0]?.value
      ? null
      : `Cubepals picked Minecraft ${preview.gameVersion}, the newest that everything in ${preview.from} runs on.`
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
