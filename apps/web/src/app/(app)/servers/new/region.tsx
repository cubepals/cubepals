// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Where a new server runs, as the create page asks it: in the region nearest the player
 * (lib/nearest-region.ts), said in the bar, where a press opens the regions to pick another. Only
 * where there is more than one; with one, the bar says nothing about it.
 *
 * The country comes from the request that rendered the page (layout.tsx), never from the player,
 * and stays in the page. Moving a server later is its settings' Location, not this.
 */
import { Globe } from 'lucide-react'
import { createContext, type ReactNode, useContext, useId, useRef, useState } from 'react'
import { startingRegion } from '../../../../lib/nearest-region'
import { Badge, Popover } from '../../../../ui'
import styles from './create.module.css'

/** Where each region Blockly knows runs, and who it is near. Another region shows its name only. */
const PLACES: Record<string, string> = {
  eu: 'Frankfurt · Europe, the Middle East, Africa',
  us: 'Virginia · the US, Canada, Latin America',
}

const Country = createContext<string | null>(null)

/** The player's country, as the edge their request came through read it, for the page below. */
export function PlayerCountry({ country, children }: { country: string | null; children: ReactNode }) {
  return <Country value={country}>{children}</Country>
}

export interface Region {
  offered: readonly { key: string; label: string }[]
  /** Where the server is made: the one picked, else the nearest, else the first. */
  key: string | undefined
  /** The region nearest the player, when where they are says which. */
  nearest: string | null
  /** The one picked by hand, carried through paying for a plan; null while it is Blockly's pick. */
  picked: string | null
  choose: (key: string) => void
  /** What the bar says about it: the picker, or nothing where there is one region to run in. */
  said: ReactNode
}

/** Where the server will run, given the regions offered and one picked before paying for a plan. */
export function useRegion(
  regions: readonly { key: string; label: string }[] | undefined,
  kept: string | null,
) {
  const country = useContext(Country)
  const [picked, setPicked] = useState(kept)
  const offered = regions ?? []
  const start = startingRegion(
    country,
    offered.map((one) => one.key),
  )
  const chosen = offered.some((one) => one.key === picked) ? picked : null
  const region: Omit<Region, 'said'> = {
    offered,
    key: chosen ?? start?.key,
    nearest: start?.nearest ? start.key : null,
    picked: chosen,
    choose: setPicked,
  }
  return { ...region, said: offered.length > 1 ? <RegionPicker region={region} /> : null }
}

/**
 * The region in the bar, styled as the release beside it, and the regions it opens to. A press,
 * Space or Enter picks and closes it; the arrow keys move through them as a radio group does, the
 * bar following, and leave it open.
 */
function RegionPicker({ region }: { region: Omit<Region, 'said'> }) {
  const [open, setOpen] = useState(false)
  const checked = useRef<HTMLInputElement>(null)
  const arrowed = useRef(false)
  const title = useId()
  const current = region.offered.find((one) => one.key === region.key)
  if (current === undefined) return null
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Where it runs"
      placement="top-start"
      initialFocus={checked}
      anchor={(reference) => (
        <button type="button" className={styles.barRegion} {...reference()}>
          <Globe size={14} strokeWidth={1.75} aria-hidden />
          {current.label}
          {current.key === region.nearest && <span className={styles.barNearest}>, closest to you</span>}
        </button>
      )}
    >
      <div className={styles.regions}>
        <p id={title} className={`type-body-sm ${styles.regionsTitle}`}>
          Where it runs
        </p>
        <p className="type-body-sm">Pick where most of your friends play from. Closer means less lag.</p>
        <div role="radiogroup" aria-labelledby={title} className={styles.regionList}>
          {region.offered.map((one) => (
            <label key={one.key} className={styles.regionOption}>
              <input
                ref={one.key === region.key ? checked : undefined}
                type="radio"
                name="region"
                value={one.key}
                checked={one.key === region.key}
                onChange={() => region.choose(one.key)}
                // An arrow key checks the next one, with a click of its own, and leaves it open.
                onKeyDown={(event) => {
                  arrowed.current = event.key.startsWith('Arrow')
                  if (event.key === 'Enter') setOpen(false)
                }}
                onKeyUp={() => {
                  arrowed.current = false
                }}
                onClick={() => arrowed.current || setOpen(false)}
              />
              <span className={styles.regionName}>
                {one.label}
                {one.key === region.nearest && <Badge tone="grass">Closest to you</Badge>}
              </span>
              {PLACES[one.key] && <span className="type-body-sm">{PLACES[one.key]}</span>}
            </label>
          ))}
        </div>
        <p className={`type-caption ${styles.quiet}`}>
          You can move it later in its settings. The world moves with it.
        </p>
      </div>
    </Popover>
  )
}
