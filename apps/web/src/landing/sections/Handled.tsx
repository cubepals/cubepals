// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * What Cubepals runs under every world so nobody has to learn it, drawn as the parts under the
 * island's world and read one at a time (stack/): the world, the game on it, the machine that
 * sleeps while nobody plays, the door friends come in at, and the backups; then a friend joining
 * through all of them. Every part holds on every plan, except where it says which plan has it. Not
 * how a server is made, which is Steps.tsx.
 */
import { seenMark } from '../../app/(public)/steps'
import { SOURCE_URL } from '../../ui/brand'
import { OutLink } from '../../ui/out-link'
import { type Said, Stack } from '../stack/Stack'
import styles from './handled.module.css'

export function Handled({ bedrock, plus, kept }: { bedrock: boolean; plus: string | null; kept: number }) {
  const steps: Said[] = [
    {
      step: 'world',
      count: '00 · The world',
      title: 'Your world is yours',
      said: 'Download it whenever you like, or start from a world you already have.',
    },
    {
      step: 'game',
      count: '01 · The game',
      title: 'What you play is one choice',
      said: `Survival, creative or a whole modpack: pick one, and Cubepals sets all of it up.${plus ? ` Modpacks come with ${plus}.` : ''}`,
    },
    {
      step: 'power',
      count: '02 · Asleep or awake',
      title: 'Asleep when nobody’s on',
      said: 'Say how many of you play and it’s made big enough. Soon after everyone leaves it saves the world and sleeps, and hours only count while it’s running.',
    },
    {
      step: 'door',
      count: '03 · The door',
      title: 'One address, and you say who gets in',
      said: bedrock
        ? 'Friends on PC, phones and tablets join the same world at the same address: anyone with it, or only the people you add.'
        : 'Friends join from Minecraft’s server list, with nothing to install: anyone with the address, or only the people you add.',
    },
    {
      step: 'backups',
      count: '04 · Backups',
      title: 'A backup every time it sleeps',
      said: `Go back to any of your last sessions, up to ${kept} of them, and a copy is kept before anything that can’t be undone.`,
    },
    {
      step: 'join',
      count: '05 · A friend joins',
      title: 'Your friends join. Your server wakes up.',
      said: 'They type the address, the door lets them in, the server wakes and the game loads. Your world is there.',
    },
  ]
  return (
    <section className={styles.handled} data-tone="ink" aria-labelledby="handled" {...seenMark('handled')}>
      <div className="lp-sheet">
        <header className={`lp-pad ${styles.head}`}>
          <p className="lp-label">Done for you</p>
          <h2 id="handled" className={`lp-h2 lp-arrive ${styles.title}`}>
            Everything else, handled.
          </h2>
          <p className="lp-lede lp-arrive">
            Every world on Cubepals stands on the same four parts. We run all of them, so nobody has to learn
            one, and how they’re run is public: <OutLink href={SOURCE_URL}>read the code</OutLink>.
          </p>
        </header>
        <Stack steps={steps} told={{ plus, kept }} bedrock={bedrock} />
      </div>
    </section>
  )
}
