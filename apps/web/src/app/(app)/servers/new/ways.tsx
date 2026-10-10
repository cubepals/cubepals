/**
 * The answers to "What to play" on the create-server page: Minecraft's own three first, and every
 * other way behind "More ways to play", in two groups, game modes and modpacks. The templates'
 * names, lines and pictures are the same for everyone (`TEMPLATE_CARDS`), so they are drawn at
 * once; what depends on the account, whether the plan runs each and the packs offered by name,
 * settles in as it arrives, in place.
 *
 * It does not decide what picking does, check a choice, or show the pack search: the page does.
 */
import {
  type CreateOptions,
  type PlanFit,
  type SetupSourceInput,
  TEMPLATE_CARDS,
  type TemplateCard,
  type TemplateKey,
} from '@blockly/contracts'
import { ChevronDown } from 'lucide-react'
import { type Ref, useEffect, useId, useState } from 'react'
import styles from './create.module.css'
import { paidFor } from './modpacks'
import { curatedMeta, curatedPicture, wayPicture } from './thumb'
import { Way } from './way'

/**
 * The ways shown before anything else: the three modes Minecraft's own new-world screen offers,
 * which every player already knows. The rest wait under "More ways to play".
 */
const FIRST: readonly TemplateKey[] = ['survival', 'creative', 'hardcore']
/** Whether this browser last left "More ways to play" open. */
const MORE_KEY = 'cubepals:create:more'

export function Ways({
  live,
  from,
  checking,
  locked,
  modpackLine,
  ownPackLine,
  modpackRef,
  onTemplate,
  onCurated,
  onModpacks,
  onOwnPack,
}: {
  /** What the control plane says for this account; undefined until it has answered. */
  live: Pick<CreateOptions, 'templates' | 'packs'> | undefined
  from: SetupSourceInput | null
  /** The key being checked: a template's, or `curated:` and a pack's. */
  checking: string | null
  /** The plan can't make another server, so nothing here can be picked. */
  locked: boolean
  /** The pack picked from the search, said on "A modpack" in place of its line. */
  modpackLine: string | undefined
  /** The pack they dropped, said on "A pack you have" in place of its line. */
  ownPackLine: string | undefined
  modpackRef: Ref<HTMLButtonElement>
  onTemplate: (key: string) => void
  onCurated: (key: string) => void
  onModpacks: () => void
  onOwnPack: () => void
}) {
  const region = useId()
  const [more, toggle] = useMore(from)

  // Until the account's answer is in, a template is shown as fitting: Minecraft's own three run on
  // every plan, and a pick is checked before it counts anyway.
  const fits = (key: string): PlanFit | null => live?.templates.find((one) => one.key === key)?.fits ?? null
  // What the plan runs before what it doesn't, each in the cards' own order (the sort is stable),
  // as the control plane orders them too.
  const later = (key: string) => (fits(key)?.allowed === false ? 1 : 0)
  const card = (one: TemplateCard) => {
    const fit = fits(one.key)
    const why = fit === null || fit.allowed ? null : fit.reason
    return (
      <Way
        key={one.key}
        picture={wayPicture(one.icon)}
        title={one.title}
        blurb={one.blurb}
        why={why}
        picked={from?.kind === 'template' && from.key === one.key}
        busy={checking === one.key}
        disabled={locked || (fit !== null && why !== null && !paidFor(fit))}
        onPick={() => onTemplate(one.key)}
      />
    )
  }
  const first = TEMPLATE_CARDS.filter((one) => (FIRST as readonly string[]).includes(one.key))
  const modes = TEMPLATE_CARDS.filter(
    (one) => !one.advanced && !(FIRST as readonly string[]).includes(one.key),
  ).sort((a, b) => later(a.key) - later(b.key))
  const packs = live?.packs ?? []
  const pack = (one: (typeof packs)[number]) => {
    const why = one.fits.allowed ? null : one.fits.reason
    return (
      <Way
        key={one.key}
        picture={curatedPicture(one)}
        title={one.way?.title ?? one.name}
        blurb={one.blurb}
        meta={curatedMeta(one)}
        why={why}
        picked={from?.kind === 'curated' && from.key === one.key}
        busy={checking === `curated:${one.key}`}
        disabled={locked || (why !== null && !paidFor(one.fits))}
        onPick={() => onCurated(one.key)}
      />
    )
  }
  return (
    <>
      <div className={styles.ways}>
        {first.map(card)}
        <button
          type="button"
          className={styles.row}
          data-more
          aria-expanded={more}
          aria-controls={region}
          onClick={toggle}
        >
          <span className={styles.thumb} aria-hidden>
            <ChevronDown size={20} strokeWidth={2} className={styles.moreMark} />
          </span>
          <span className={styles.rowText}>
            <span className={styles.rowTitle}>More ways to play</span>
            <span className={styles.rowBlurb}>Lifesteal, OneBlock, modpacks and more.</span>
          </span>
        </button>
      </div>
      <div id={region} className={styles.more} hidden={!more}>
        <div className={styles.group}>
          <h3 className={`type-label ${styles.groupTitle}`}>Game modes</h3>
          <div className={styles.ways}>
            {modes.map(card)}
            {/* A pack that stands for a way to play sits with the ways, under that way's name. */}
            {packs.filter((one) => one.way !== null).map(pack)}
          </div>
        </div>
        <div className={styles.group}>
          <h3 className={`type-label ${styles.groupTitle}`}>Modpacks</h3>
          <div className={styles.ways}>
            {packs.filter((one) => one.way === null).map(pack)}
            {/* Which packs a plan runs is said pack by pack, in the search. */}
            <Way
              ref={modpackRef}
              picture={wayPicture('modpack')}
              title="A modpack"
              blurb={modpackLine ?? 'Play a pack someone made. Cubepals sets up all of it.'}
              why={null}
              picked={from?.kind === 'modpack'}
              busy={false}
              disabled={locked}
              onPick={onModpacks}
            />
            {/* A pack they already have, as whatever file it came as: Cubepals works out which. */}
            <Way
              picture={wayPicture('ownpack')}
              title="A pack you have"
              blurb={ownPackLine ?? 'Drop its file: a server pack, a Modrinth pack or a launcher’s export.'}
              why={null}
              picked={from?.kind === 'import'}
              busy={false}
              disabled={locked}
              onPick={onOwnPack}
            />
          </div>
        </div>
        <ServerTypes fits={fits} from={from} checking={checking} locked={locked} onTemplate={onTemplate} />
      </div>
    </>
  )
}

/**
 * Whether "More ways to play" is open: open from the start when what is picked is in it, and as
 * this browser last left it. Read once the page is on screen, since the server can't know it.
 */
function useMore(from: SetupSourceInput | null): [boolean, () => void] {
  const [more, setMore] = useState(
    from !== null &&
      from.kind !== 'server' &&
      !(from.kind === 'template' && (FIRST as readonly string[]).includes(from.key)),
  )
  useEffect(() => {
    try {
      if (localStorage.getItem(MORE_KEY) === 'open') setMore(true)
    } catch {
      // A browser that refuses storage opens on the first three, as everyone does the first time.
    }
  }, [])
  const toggle = () => {
    setMore(!more)
    try {
      localStorage.setItem(MORE_KEY, more ? 'closed' : 'open')
    } catch {
      // Not remembered; it still opens and closes.
    }
  }
  return [more, toggle]
}

/** The server types, as tags, for the people who came looking for one by name. */
function ServerTypes({
  fits,
  from,
  checking,
  locked,
  onTemplate,
}: {
  fits: (key: string) => PlanFit | null
  from: SetupSourceInput | null
  checking: string | null
  locked: boolean
  onTemplate: (key: string) => void
}) {
  const types = TEMPLATE_CARDS.filter((one) => one.advanced)
  const outOfPlan = [
    ...new Set(
      types.flatMap((one) => {
        const fit = fits(one.key)
        return fit === null || fit.allowed ? [] : [fit.reason]
      }),
    ),
  ]
  return (
    <details>
      <summary className="type-body-sm bk-disclosure">Picking mods yourself?</summary>
      <div className="bk-row bk-wrap" style={{ gap: 'var(--space-8)', marginBlockStart: 'var(--space-12)' }}>
        {types.map((one) => {
          const fit = fits(one.key)
          return (
            <button
              key={one.key}
              type="button"
              className="bk-tag"
              aria-pressed={from?.kind === 'template' && from.key === one.key}
              aria-busy={checking === one.key || undefined}
              disabled={locked || (fit !== null && !fit.allowed && !paidFor(fit))}
              onClick={() => onTemplate(one.key)}
            >
              {one.title}
            </button>
          )
        })}
      </div>
      {outOfPlan.map((why) => (
        <p key={why} className={`type-body-sm ${styles.quiet}`}>
          {why}
        </p>
      ))}
    </details>
  )
}
