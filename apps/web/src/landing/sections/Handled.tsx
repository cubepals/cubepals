// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What Cubepals does for every server, so nobody has to learn it: eight things, each in a sentence
 * a player would say, set in a ruled table like the rest of the sheet. Every one holds on every
 * plan, except where it says which plan has it. Not how a server is made, which is Steps.tsx.
 */
import { seenMark } from '../../app/(public)/steps'
import { SOURCE_URL } from '../../ui/brand'
import { OutLink } from '../../ui/out-link'
import { PixelIcon, type PixelIconName } from '../../ui/pixel-icon'
import styles from './handled.module.css'

export function Handled({ bedrock, plus }: { bedrock: boolean; plus: string | null }) {
  const done: { icon: PixelIconName; title: string; said: React.ReactNode }[] = [
    {
      icon: 'moon',
      title: 'Asleep when nobody’s on',
      said: 'Soon after everyone leaves, it saves the world and sleeps. Joining wakes it again.',
    },
    {
      icon: 'chest',
      title: 'A backup every time it sleeps',
      said: 'Go back to any of your last sessions, and a copy is kept before anything that can’t be undone.',
    },
    {
      icon: 'download',
      title: 'Your world is yours',
      said: 'Download it whenever you like, or start from a world you already have.',
    },
    {
      icon: 'anvil',
      title: 'A modpack is one choice',
      said: `Pick a pack and Cubepals installs all of it.${plus ? ` With ${plus}.` : ''}`,
    },
    bedrock
      ? {
          icon: 'bridge',
          title: 'Java and Bedrock together',
          said: 'Friends on PC, phones and tablets join the same world, at the same address.',
        }
      : {
          icon: 'bridge',
          title: 'Plain Minecraft',
          said: 'The game as it comes, with nothing for your friends to install.',
        },
    {
      icon: 'friends',
      title: 'You say who gets in',
      said: 'Anyone with the address, or only the people you add.',
    },
    {
      icon: 'crowd',
      title: 'Sized for your group',
      said: 'Say how many of you play, and the server is made big enough for you.',
    },
    {
      icon: 'eye',
      title: 'Open source',
      said: (
        <>
          How your server is run is public. <OutLink href={SOURCE_URL}>Read the code</OutLink>.
        </>
      ),
    },
  ]
  return (
    <section className={styles.handled} data-tone="paper" aria-labelledby="handled" {...seenMark('handled')}>
      <div className="lp-sheet">
        <header className={`lp-pad ${styles.head}`}>
          <p className="lp-label">Done for you</p>
          <h2 id="handled" className={`lp-h2 lp-arrive ${styles.title}`}>
            Everything else, handled.
          </h2>
          <p className="lp-lede lp-arrive">
            The parts of running a server nobody wants to learn are done before you ask, and nothing is ever
            hidden from you.
          </p>
        </header>
        <ul className={styles.grid}>
          {done.map((one) => (
            <li key={one.title} className={`${styles.cell} lp-arrive`}>
              <PixelIcon name={one.icon} size={24} className={styles.icon} />
              <h3 className={styles.name}>{one.title}</h3>
              <p className="lp-body">{one.said}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
