/**
 * What a section of proof is built from: `Section` (which also says where the camera stands,
 * when a section is a place on the page), `Demo`, `Facts`, and `Strata`, the edge between two
 * grounds.
 */
import type { CSSProperties, ReactNode } from 'react'
import { type RoomKey, roomFaces, roomY } from './engine/chunk'
import { ROOM_NAMES } from './names'

/** What the ground is like at a section's depth; landing.css gives each its colours. */
export type Tone = 'night' | 'paper' | 'stone' | 'slate' | 'bedrock'

/** How close the camera stands: the whole column, the chunk, the house, one room. */
export type Zoom = 'far' | 'wide' | 'near' | 'close'

/**
 * More to say to the camera than a side and a distance: which way round it stands (`az`, degrees;
 * 0 faces the +z wall and 90 the +x wall), how high (`el`, degrees), how many blocks fit top to
 * bottom (`span`), the lens (`fov`), how far down the screen it holds what it looks at (`drop`,
 * 0 to 1), how far round it walks while the section is read (`turn`, degrees), and whether the
 * other worlds are there (`crowd`, 0 to 1).
 */
export interface Shot {
  az?: number
  el?: number
  span?: number
  fov?: number
  drop?: number
  turn?: number
  crowd?: number
  /** Where across the chunk it looks, in blocks, when that isn't the middle. */
  x?: number
  z?: number
}

/** A shot as the attributes the camera reads off a section. */
export const shotAttributes = (shot: Shot | undefined) => ({
  'data-az': shot?.az,
  'data-el': shot?.el,
  'data-span': shot?.span,
  'data-fov': shot?.fov,
  'data-drop': shot?.drop,
  'data-turn': shot?.turn,
  'data-crowd': shot?.crowd,
  'data-x': shot?.x,
  'data-z': shot?.z,
})

/**
 * One stratum of the page. `room` names the room in the chunk this section is about: the camera
 * flies to it and looks in through its open wall, and its lamps come on while the section is in
 * the middle of the screen. `side` is the side of the screen the chunk is held on while this
 * section is read; the words take the other, on a plate of the ground's own colour, so the drawing
 * can run behind them. `zoom` and `shot` say the rest of where the camera stands. The print takes
 * its palette from `tone`, so the chunk inverts where the ground goes dark.
 */
export function Section({
  id,
  name,
  tone,
  room,
  y,
  side,
  zoom,
  shot,
  act,
  label,
  className,
  bare,
  children,
}: {
  id?: string
  /** A few words for where this is, said by the cue that leads to it. A room's section has its room's name. */
  name?: string
  tone: Tone
  room?: RoomKey
  /** A Minecraft Y to hold in view, for a section with no room of its own. */
  y?: number
  side?: 'left' | 'right' | 'center'
  zoom?: Zoom
  shot?: Shot
  /**
   * What the chunk puts on for this section: `play` shows the way to play that is chosen, on the
   * grass; `ledger` lights the vault and its blocks; `friends` has everyone in; `knock` has
   * whoever typed the address standing at the end of the path with a torch.
   */
  act?: 'play' | 'ledger' | 'friends' | 'knock'
  /** The section's name for a screen reader, where its heading isn't enough. */
  label?: string
  className?: string
  /**
   * Only what the section says, and none of where it stands: for the film (film/), where a
   * section is the proof opened over a beat's picture and not a place the page rests.
   */
  bare?: boolean
  children: ReactNode
}) {
  if (bare)
    return (
      <div className={className ? `bl-proof__body ${className}` : 'bl-proof__body'} data-tone={tone}>
        {children}
      </div>
    )
  const depth = room ? roomY(room) : y
  // A room that opens to the left is looked into from the left, so the chunk stands on the right.
  const stands = side ?? (room ? (roomFaces(room) === 'left' ? 'right' : 'left') : 'right')
  return (
    <section
      // A room's section answers to the room's name, so the gauge and a sent link can reach it.
      id={id ?? room}
      data-name={name ?? (room ? ROOM_NAMES[room] : undefined)}
      className={className ? `bl-section ${className}` : 'bl-section'}
      data-tone={tone}
      data-room={room}
      data-y={depth}
      data-side={stands}
      data-zoom={zoom ?? (room ? 'close' : 'wide')}
      {...shotAttributes(shot)}
      data-act={act}
      aria-label={label}
    >
      <div className="bl-col" data-stop>
        {children}
      </div>
    </section>
  )
}

/**
 * The frame every demonstration sits in. `note` is the one honest line under it: what is sped up,
 * what is an example, what is modelled rather than measured.
 */
export function Demo({
  label,
  note,
  className,
  children,
}: {
  /** What the demonstration is, for a screen reader. */
  label: string
  note?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <figure className="bl-demo" aria-label={label}>
      <div className={className ? `bl-frame bl-demo__body ${className}` : 'bl-frame bl-demo__body'}>
        {children}
      </div>
      {note && <figcaption className="bl-small bl-demo__note">{note}</figcaption>}
    </figure>
  )
}

/**
 * A short row of real facts under a demonstration: a name and its value, in the machine's voice.
 * A value said in words, where the code holds nothing to quote, is `said` and set as words.
 */
export function Facts({ items }: { items: { name: string; value: ReactNode; said?: boolean }[] }) {
  return (
    <dl className="bl-facts">
      {items.map((item) => (
        <div key={item.name}>
          <dt className="bl-small">{item.name}</dt>
          <dd className={item.said ? 'bl-said' : 'bl-mono'}>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The edge between two strata: the lower colour arriving in rows of denser dots. */
export function Strata({ from, to, drawn }: { from: string; to: string; drawn?: boolean }) {
  return (
    <div
      className="bl-strata"
      style={{ '--from': from, '--to': to } as CSSProperties}
      // Part of a scene that is nothing without the drawing, and goes when the drawing does.
      data-drawn={drawn || undefined}
      aria-hidden
    >
      <i className="bl-dither" data-level="1" />
      <i className="bl-dither" data-level="2" />
      <i className="bl-dither" data-level="3" />
      <i className="bl-dither" data-level="4" />
      <i />
    </div>
  )
}
