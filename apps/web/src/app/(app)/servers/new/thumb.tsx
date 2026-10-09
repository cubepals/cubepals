/**
 * The small picture beside a choice on the create-server page, with the mark on its corner that
 * says whether it is picked or being checked. It knows how a choice looks, not how it is chosen:
 * that lives in `way.tsx`, `modpacks.tsx` and the page.
 */
import type { CuratedPackView, ModpackHit, PlayIcon } from '@blockly/contracts'
import { Check, Loader2 } from 'lucide-react'
import Image from 'next/image'
import { iconSrc, playIconSrc } from '../../../../lib/present'
import styles from './create.module.css'

/** A choice's picture: a way to play's item on its colour, a pack's own image, or a server's icon. */
export interface Picture {
  src: string
  /** The way to play it draws, which picks the colour it sits on. */
  icon?: PlayIcon
  /** A pack's own image, which fills its square rather than sitting in it as pixels do. */
  photo?: boolean
}

/** The server types have no item of their own; they wear Blockly's. */
export const wayPicture = (icon: PlayIcon | null): Picture =>
  icon === null ? { src: iconSrc(null) } : { src: playIconSrc(icon), icon }

export const packPicture = (hit: ModpackHit): Picture =>
  hit.iconUrl === null ? wayPicture('modpack') : { src: hit.iconUrl, photo: true }

/** A pack that stands for a way to play wears that way's item; any other, its own picture. */
export const curatedPicture = (pack: CuratedPackView): Picture =>
  pack.way !== null
    ? wayPicture(pack.way.icon)
    : pack.icon === null
      ? wayPicture('modpack')
      : { src: pack.icon, photo: true }

/**
 * Under a pack Blockly offers, quietly: the Minecraft it is, whether friends need anything, and
 * whose it is. Its authors' credit goes wherever their pack does, with its own name where the
 * card carries the way to play's.
 */
export const curatedMeta = (pack: CuratedPackView): string =>
  [
    ...(pack.way === null ? [] : [pack.name]),
    `Minecraft ${pack.gameVersion}`,
    pack.playersNeedIt ? 'Friends install the pack' : 'Friends join with plain Minecraft',
    `By ${pack.authors}`,
  ].join(' · ')

/**
 * A choice's picture, and on its corner how the choice stands: checked once picked, or the wait
 * while it is checked. On the corner rather than beside the words, so they never move over.
 */
export function Thumb({ picture, state }: { picture: Picture; state?: 'picked' | 'busy' | undefined }) {
  return (
    <span className={styles.thumb} data-icon={picture.icon} data-photo={picture.photo || undefined}>
      {picture.photo ? (
        // Modrinth serves a 96 px webp already sized for this; running it through Next's
        // optimiser would spend Blockly's bandwidth re-encoding someone else's thumbnail.
        // biome-ignore lint/performance/noImgElement: a pre-sized third-party thumbnail
        <img src={picture.src} alt="" width={48} height={48} loading="lazy" />
      ) : (
        <Image src={picture.src} alt="" width={32} height={32} />
      )}
      {state !== undefined && (
        <span key={state} className={styles.badge} data-state={state} aria-hidden>
          {state === 'busy' ? (
            <Loader2 size={14} strokeWidth={2.5} className="bk-spin" />
          ) : (
            <Check size={14} strokeWidth={3} />
          )}
        </span>
      )}
    </span>
  )
}
