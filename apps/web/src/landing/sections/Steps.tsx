// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * How a server is made and played, in three steps, each beside the part of the product that does
 * it, drawn with the product's own pieces and words: the ways to play the create page offers, the
 * row the game's server list shows for a sleeping server, and a day of a server's hours. What the
 * player decides is what only they know; the section says that Cubepals decides the rest. Not the
 * list of what it decides, which is Handled.tsx.
 */
import { PARTY_SIZES, TEMPLATE_CARDS } from '@blockly/contracts'
import { seenMark } from '../../app/(public)/steps'
import { OPERATOR } from '../../legal/operator'
import styles from './steps.module.css'

/** The ways to play the first step shows, of the create page's own: the short names, survival first. */
const SHOWN_KEYS = ['survival', 'creative', 'hardcore', 'skyblock', 'oneblock', 'lifesteal']
const SHOWN = TEMPLATE_CARDS.filter((way) => SHOWN_KEYS.includes(way.key))

/** The drawn server's address: one Cubepals keeps, so typing it leads somewhere good. */
const ADDRESS = `sunset-valley.${OPERATOR.playDomain}`

/**
 * What the game's server list shows under a sleeping server's name: the edge's own notice
 * (`ASLEEP` in apps/edge/agent.ts, its default where the operator sets none).
 */
const ASLEEP_NOTICE = 'Sleeping · join to wake it up'

/**
 * One example day of a server, in the hours of a clock: when it was on, and when it slept. Not a
 * measurement: the shape of an evening's play, with the quarter of an hour it stays up after.
 */
const DAY = [
  { from: 17.5, to: 19.25, on: true },
  { from: 20.5, to: 23.25, on: true },
] as const

const hoursOn = DAY.reduce((sum, part) => sum + (part.to - part.from), 0)

export function Steps() {
  return (
    <section className={styles.steps} data-tone="paper" aria-labelledby="steps" {...seenMark('steps')}>
      <div className="lp-sheet">
        <header className={`lp-pad ${styles.head}`}>
          <p className="lp-label">How it works</p>
          <h2 id="steps" className={`lp-h2 lp-arrive ${styles.title}`}>
            You choose the game. Cubepals does the rest.
          </h2>
          <p className="lp-lede lp-arrive">
            You decide what only you know: what to play, who’s playing and what it’s called. The setup, the
            machine and the waking up are Cubepals’.
          </p>
        </header>
        <ol className={styles.grid}>
          <li className={styles.step}>
            <p className={styles.count}>01</p>
            <h3 className="lp-h3">Pick what to play</h3>
            <p className="lp-body">
              Survival, creative or a modpack, and how many of you play. Then name it.
            </p>
            <div className={`${styles.demo} lp-arrive`} aria-hidden>
              <div className={styles.ways}>
                {SHOWN.map((way, index) => (
                  <span key={way.key} className={styles.way} data-chosen={index === 0 || undefined}>
                    {/* biome-ignore lint/performance/noImgElement: a pixel picture at its own size. */}
                    <img src={`/play-icons/${way.icon}.svg`} width={24} height={24} alt="" />
                    {way.title}
                  </span>
                ))}
              </div>
              <div className={styles.party}>
                <span className={styles.partyLabel}>Who’s playing</span>
                {PARTY_SIZES.map((size, index) => (
                  <span key={size} className={styles.size} data-chosen={index === 0 || undefined}>
                    {size === 'more' ? 'More' : size}
                  </span>
                ))}
              </div>
            </div>
          </li>
          <li className={styles.step}>
            <p className={styles.count}>02</p>
            <h3 className="lp-h3">Send one address</h3>
            <p className="lp-body">
              Friends add it to Minecraft’s server list like any other server, and join.
            </p>
            <div className={`${styles.demo} ${styles.game} lp-arrive`} aria-hidden>
              <div className={styles.row}>
                {/* biome-ignore lint/performance/noImgElement: a pixel picture at its own size. */}
                <img src="/server-icons/grass.svg" width={48} height={48} alt="" />
                <span className={styles.rowWords}>
                  <span className={styles.rowName}>
                    Sunset Valley <span className={styles.rowCount}>0/5</span>
                  </span>
                  <span className={styles.rowLine}>A world for the weekend</span>
                  <span className={styles.rowNotice}>{ASLEEP_NOTICE}</span>
                </span>
              </div>
              <p className={styles.address}>
                <span className={styles.addressKey}>Server address</span>
                <span className={styles.addressValue}>{ADDRESS}</span>
              </p>
            </div>
          </li>
          <li className={styles.step}>
            <p className={styles.count}>03</p>
            <h3 className="lp-h3">Play. It sleeps after.</h3>
            <p className="lp-body">
              A join wakes it, and it sleeps soon after everyone has gone. Hours only count while it’s
              running.
            </p>
            <div className={`${styles.demo} lp-arrive`} aria-hidden>
              <div className={styles.day}>
                {DAY.map((part) => (
                  <span
                    key={part.from}
                    className={styles.on}
                    style={{
                      left: `${(part.from / 24) * 100}%`,
                      width: `${((part.to - part.from) / 24) * 100}%`,
                    }}
                  />
                ))}
              </div>
              <div className={styles.clock}>
                <span>00:00</span>
                <span>12:00</span>
                <span>24:00</span>
              </div>
              <dl className={styles.tally}>
                <div>
                  <dt>Running</dt>
                  <dd>{hoursOn} h</dd>
                </div>
                <div>
                  <dt>Asleep</dt>
                  <dd>{24 - hoursOn} h</dd>
                </div>
                <div>
                  <dt>Hours used</dt>
                  <dd>{hoursOn}</dd>
                </div>
              </dl>
            </div>
          </li>
        </ol>
      </div>
    </section>
  )
}
