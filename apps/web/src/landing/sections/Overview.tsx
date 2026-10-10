// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The two scenes that stand back: the turn, where the whole column is in view with its rooms
 * named, and all the worlds under one night sky.
 */
import type { ReactNode } from 'react'
import { ROOMS, roomFaces, roomY } from '../engine/chunk'
import { ROOM_NAMES } from '../names'
import styles from './overview.module.css'
import { RoomLights } from './RoomLights'
import { Stars } from './Stars'

/**
 * The turn of the page. Everything above this is what a player needs; here the camera stands back
 * until the whole chunk is in view, grass to bedrock, and the rooms under the house light up one
 * after another, each with its name on it and a way straight to it. On a narrow screen the names
 * are a plain list. Whatever it is given is set under the words: the film's way past the dig.
 * `played`, it is one screen, and the rooms light by the clock as the page comes to rest on it.
 */
export function Overview({ children, played }: { children?: ReactNode; played?: boolean }) {
  return (
    <section
      id="underneath"
      className={played ? `bl-section ${styles.overview} ${styles.brief}` : `bl-section ${styles.overview}`}
      data-name="What’s underneath"
      data-tone="paper"
      data-y="0"
      data-side="0.72"
      data-zoom="far"
      aria-labelledby="underneath-title"
    >
      <RoomLights how={played ? 'played' : 'sequence'} />
      <div className={styles.held} data-scene>
        <div className={styles.words} data-words>
          <h2 id="underneath-title" className="bl-display">
            Everything else is underneath
          </h2>
          <p className="bl-lede">
            The rest of this page is what Cubepals does that you never see, and at the bottom what it is still
            building. You won’t need any of it to play.
          </p>
          {children}
        </div>
        <ol className={styles.rooms} data-rooms>
          {ROOMS.map((room) => (
            <li key={room.key} data-pin={room.key} data-faces={roomFaces(room.key)}>
              <a href={`#${room.key}`}>
                <span className="bl-game bl-num">Y {Math.round(roomY(room.key))}</span>
                {ROOM_NAMES[room.key]}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

/**
 * Further back still, and lower. The chunk the page dug through is one server's world; from here
 * it is one of a great many under one night sky, reaching away to the horizon, most of them dark
 * because most of the time a server is asleep, and a few with their lamps lit. The camera stands
 * low enough that the sky is half the picture, and the words are set in the sky. `played`, it is
 * one screen, as in the film.
 */
export function Worlds({ played }: { played?: boolean } = {}) {
  return (
    <section
      id="worlds"
      className={
        played
          ? `bl-section ${styles.overview} ${styles.worlds} ${styles.brief}`
          : `bl-section ${styles.overview} ${styles.worlds}`
      }
      data-name="All the worlds"
      data-act="friends"
      data-tone="dusk"
      data-y="62"
      data-side="0.6"
      data-zoom="far"
      data-az="30"
      data-el="14"
      data-span="130"
      data-fov="38"
      data-drop="0.74"
      data-turn="34"
      data-crowd="1"
      data-drawn
      aria-labelledby="worlds-title"
    >
      <div className={styles.held} data-scene>
        <Stars className={styles.stars} />
        <span className={`bl-moon ${styles.moon}`} aria-hidden />
        <div className={styles.words} data-words>
          <h2 id="worlds-title" className="bl-display">
            Every server is a world like this one
          </h2>
          <p className="bl-lede">The dark ones are asleep.</p>
          <p className="bl-aside">A drawing of the idea, not a count of servers.</p>
        </div>
      </div>
    </section>
  )
}
