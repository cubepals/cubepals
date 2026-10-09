/**
 * The chunk the landing page digs through: a house on the surface, and under it one room for each
 * thing Blockly does that a player never sees. Built by hand, block by block, and judged by eye.
 *
 * Height here is in blocks from the grass (y = 0). Minecraft's own Y, as the gauge shows it, is
 * `SURFACE_Y + y`: the grass is at Y 64, deepslate begins at Y 0 and bedrock at Y −64, as in the
 * game. The dig is to scale: one block here is one block there.
 */
import { hash3, Kind, World } from './world'

export const SIZE = 16
export const SURFACE_Y = 64
export const TOP = 13
export const BOTTOM = -128

/** The rooms, top to bottom, by the Minecraft Y of their floor. Each has its own light switch. */
export const ROOMS = [
  { key: 'edge', floorY: 52, wall: 'z' },
  { key: 'sleep', floorY: 40, wall: 'x' },
  { key: 'machine', floorY: 28, wall: 'z' },
  { key: 'packs', floorY: 16, wall: 'x' },
  { key: 'backups', floorY: 4, wall: 'z' },
  { key: 'runtimes', floorY: -16, wall: 'x' },
  { key: 'fleet', floorY: -34, wall: 'z' },
] as const
export type RoomKey = (typeof ROOMS)[number]['key']

const ROOM_HEIGHT = 7
const ROOM_DEPTH = 7

/** Light switches: 1 is the house, then one per room in order; the cellar has its own. */
export const HOME = 1
export const CELLAR = 12
/** A switch that is never on, for a place that stays dark whatever its room does. */
export const DARK = 11
/** A switch that is always on, for things that carry their own light. */
export const LIT = 13
export const groupOf = (key: RoomKey): number => 2 + ROOMS.findIndex((room) => room.key === key)

/** The Minecraft Y a section about this room should hold in the middle of the view. */
export const roomY = (key: RoomKey): number => {
  const room = ROOMS.find((candidate) => candidate.key === key)
  return (room?.floorY ?? SURFACE_Y) + ROOM_HEIGHT / 2
}

// Every room is the same box, cut through one wall: twelve blocks along the wall, seven deep.
const ROOM_LO = 2
const ROOM_HI = SIZE - 3
const ROOM_BACK = SIZE - ROOM_DEPTH

/**
 * A place inside a room, in the room's own terms, as a place in the world: `u` runs along the
 * wall you look through, `v` is how far in from the back wall, `h` is height above the floor.
 * Heights in the world are blocks from the grass.
 */
export function roomPlace(key: RoomKey, u: number, v: number, h: number): [number, number, number] {
  const spec = ROOMS.find((candidate) => candidate.key === key) ?? ROOMS[0]
  const y = spec.floorY - SURFACE_Y + 1 + h
  return spec.wall === 'z' ? [ROOM_LO + u, y, ROOM_BACK + v] : [ROOM_BACK + v, y, ROOM_LO + u]
}

/** The middle of a room, where a camera looking at it should point. */
export const roomCenter = (key: RoomKey): [number, number, number] =>
  roomPlace(key, 5.5, 3.5, ROOM_HEIGHT / 2 - 1.5)

/** Which way a room opens, seen from the corner the two open walls share: z-wall rooms face left. */
export const roomFaces = (key: RoomKey): 'left' | 'right' =>
  ROOMS.find((candidate) => candidate.key === key)?.wall === 'x' ? 'right' : 'left'

function strata(world: World): void {
  for (let y = BOTTOM; y <= 0; y++)
    for (let z = 0; z < SIZE; z++)
      for (let x = 0; x < SIZE; x++) {
        const r = hash3(x, y, z)
        let kind: Kind = Kind.stone
        if (y === 0) kind = Kind.grass
        else if (y >= -3 - (r > 0.6 ? 1 : 0)) kind = Kind.dirt
        else if (y > -64 + (r > 0.5 ? 1 : 0) - (r > 0.9 ? 2 : 0)) kind = r > 0.985 ? Kind.ore : Kind.stone
        else if (y > BOTTOM + 3 + Math.floor(r * 3)) kind = r > 0.988 ? Kind.ore : Kind.deepslate
        else kind = Kind.bedrock
        world.set(x, y, z, kind)
      }
}

function tree(world: World, x: number, z: number, height: number): void {
  for (let y = 1; y <= height; y++) world.set(x, y, z, Kind.log)
  for (let dy = 0; dy <= 3; dy++) {
    const reach = dy === 3 ? 1 : 2
    for (let dz = -reach; dz <= reach; dz++)
      for (let dx = -reach; dx <= reach; dx++) {
        const corner = Math.abs(dx) === reach && Math.abs(dz) === reach
        if (corner && (dy !== 1 || hash3(x + dx, dy, z + dz) > 0.4)) continue
        if (dx === 0 && dz === 0 && dy < 2) continue
        world.set(x + dx, height - 1 + dy, z + dz, Kind.leaves)
      }
  }
}

function house(world: World): void {
  const x0 = 2
  const x1 = 7
  const z0 = 2
  const z1 = 7
  // A cobble footing and plank walls, hollow, so the windows have a room to light.
  world.fill({ x0, x1, z0, z1, y0: 1, y1: 1 }, Kind.cobble)
  world.fill({ x0, x1, z0, z1, y0: 2, y1: 4 }, Kind.planks)
  world.fill({ x0: x0 + 1, x1: x1 - 1, z0: z0 + 1, z1: z1 - 1, y0: 1, y1: 4 }, Kind.air)
  // A pitched roof, ridge along x, with the gable on the wall the sun reaches.
  for (let step = 0; step <= 3; step++) {
    const za = z0 - 1 + step
    const zb = z1 + 1 - step
    if (za > zb) break
    world.fill({ x0, x1, z0: za, z1: zb, y0: 5 + step, y1: 5 + step }, Kind.roof)
    if (zb - za >= 2)
      world.fill(
        { x0, x1, z0: za + 1, z1: zb - 1, y0: 5 + step, y1: 5 + step },
        step === 0 ? Kind.air : Kind.planks,
      )
    if (zb - za >= 2 && step === 0)
      world.fill({ x0: x1, x1, z0: za + 1, z1: zb - 1, y0: 5, y1: 5 }, Kind.planks)
  }
  // The door and a window beside it on the gable, one above, two on the shaded wall.
  world.set(x1, 1, 4, Kind.dark)
  world.set(x1, 2, 4, Kind.dark)
  world.set(x1, 3, 6, Kind.glass, HOME)
  world.set(x1, 6, 4, Kind.glass, HOME)
  world.set(3, 3, z1, Kind.glass, HOME)
  world.set(5, 3, z1, Kind.glass, HOME)
  world.fill({ x0: 3, x1: 3, z0: 3, z1: 3, y0: 6, y1: 9 }, Kind.cobble)
  world.light(4.5, 3, 5, 4.5, HOME)
  world.light(8.6, 2.5, 5.5, 3, HOME)
  world.light(4.5, 2.5, 8.6, 3, HOME)
}

function surface(world: World): void {
  // Tall things stand at the back and the sides, so nothing hides the house. The pond is in front.
  for (let z = 10; z <= 14; z++)
    for (let x = 9; x <= 14; x++) {
      const corner = (x === 9 || x === 14) && (z === 10 || z === 14)
      if (!corner) world.set(x, 0, z, Kind.water)
    }
  world.set(8, 0, 12, Kind.sand)
  world.set(11, 0, 9, Kind.sand)
  world.set(12, 0, 9, Kind.sand)
  // The path from the door to the edge of the chunk, where friends arrive.
  for (let x = 8; x < SIZE; x++) world.set(x, 0, 4, Kind.path)
  world.set(10, 0, 5, Kind.path)
  world.set(13, 0, 3, Kind.path)
  // The signpost at the edge, carrying the address.
  world.set(15, 1, 6, Kind.log)
  world.set(15, 2, 6, Kind.planks)
  // A lamp by the door.
  world.set(9, 1, 6, Kind.log)
  world.set(9, 2, 6, Kind.log)
  world.set(9, 3, 6, Kind.lamp, HOME)
  world.light(9.5, 3.5, 6.5, 4.5, HOME)
  house(world)
  tree(world, 13, 1, 4)
  tree(world, 1, 12, 4)
}

/**
 * Places blocks inside a room in the room's own terms: `u` runs along the wall you look through,
 * `v` is how far in from the back wall, `h` is height above the floor.
 */
type Put = (u: number, v: number, h: number, kind: Kind, group?: number) => void

function room(world: World, spec: (typeof ROOMS)[number]): { put: Put } {
  const floor = spec.floorY - SURFACE_Y
  const group = groupOf(spec.key)
  const box =
    spec.wall === 'z'
      ? { x0: ROOM_LO, x1: ROOM_HI, z0: ROOM_BACK, z1: SIZE - 1 }
      : { x0: ROOM_BACK, x1: SIZE - 1, z0: ROOM_LO, z1: ROOM_HI }
  world.carve({ ...box, y0: floor + 1, y1: floor + ROOM_HEIGHT }, group)
  const put: Put = (u, v, h, kind, switched = 0) => {
    const [x, y, z] = roomPlace(spec.key, u, v, h)
    world.set(x, y, z, kind, switched)
  }
  const glow = (u: number, v: number, h: number, radius: number) => {
    const [x, y, z] = roomPlace(spec.key, u, v, h)
    world.light(x + 0.5, y + 0.5, z + 0.5, radius, group)
  }
  // Every room has two lamps' worth of warm light across its floor, whatever else it holds.
  glow(3, 3.5, 0, 7)
  glow(8, 3.5, 0, 7)
  return { put }
}

// A room is looked into through its open wall, from a little to one side and a little above. So
// what is worth seeing stands toward the middle of the floor and is kept low, where nothing in
// front of it hides it.

/**
 * The address: an empty room with a path in its floor, from the open wall through where the door
 * stands and round to the foot of the server. The door, the server and its chest all move, so the
 * scene draws them (engine/scenes/edge.ts).
 */
function edgeRoom(world: World): void {
  const { put } = room(world, ROOMS[0])
  for (let v = 2; v < ROOM_DEPTH; v++) {
    put(6, v, -1, Kind.path)
    put(7, v, -1, Kind.path)
  }
  for (let u = 2; u <= 5; u++) put(u, 2, -1, Kind.path)
}

/**
 * Sleep: an empty room. The server that sleeps in it, its disk, the store and the lever are all
 * things that come and go, so the scene draws every one of them (engine/scenes/sleep.ts).
 */
function sleepRoom(world: World): void {
  room(world, ROOMS[1])
}

/**
 * The machine: an empty room. The server that is started in it, its disk, its cores and the
 * lever that starts it all move, so the scene draws every one of them (engine/scenes/machine.ts).
 */
function machineRoom(world: World): void {
  room(world, ROOMS[2])
}

/**
 * Modpacks: an empty room. The pack is a chest of jars that is unpacked into the server, and
 * every part of that moves, so the scene draws all of it (engine/scenes/packs.ts).
 */
function packsRoom(world: World): void {
  room(world, ROOMS[3])
}

/**
 * Backups: an empty room. The server, its chest and the benches of copies are all dropped, shoved
 * and carried, so the scene draws every one of them (engine/scenes/backups.ts).
 */
function backupsRoom(world: World): void {
  room(world, ROOMS[4])
}

/**
 * Runtimes: one line along the floor, with a spur off it to each of three doors in the back wall
 * and a dark hall behind each door. The line comes out of a tunnel in the end wall. The doors,
 * the points and the carts are the scene's (engine/scenes/runtimes.ts).
 */
function runtimesRoom(world: World): void {
  const spec = ROOMS[5]
  const { put } = room(world, spec)
  const hollow = (u: number, v: number) => {
    const [x, y, z] = roomPlace(spec.key, u, v, 0)
    world.carve({ x0: x, x1: x, y0: y, y1: y + 1, z0: z, z1: z }, DARK)
    put(u, v, -1, Kind.rail)
  }
  for (let u = 2; u <= 11; u++) put(u, 3, -1, Kind.rail)
  for (const u of [6, 4, 2]) {
    for (let v = 0; v <= 2; v++) put(u, v, -1, Kind.rail)
    for (let v = -3; v <= -1; v++) hollow(u, v)
  }
  hollow(12, 3)
}

/**
 * The fleet: an empty room. Blockly's own machines, the worlds on them and the ledger between
 * them all move, so the scene draws them (engine/scenes/fleet.ts).
 */
function fleetRoom(world: World): void {
  room(world, ROOMS[6])
}

/**
 * The vault: a hall under the house and the path, open at the chunk's wall, where the server
 * itself stands (engine/cast.ts builds it). It lies beside the first room and
 * above the second, so none opens into another. It has no lamps of its own: the server
 * lights it.
 */
function cellar(world: World): void {
  // Two blocks short of the first room: a block is lit by one room only, so the wall between two
  // rooms is a block for each.
  world.carve({ x0: 3, x1: SIZE - 1, z0: 1, z1: 6, y0: -8, y1: -2 }, CELLAR)
}

export function buildChunk(): World {
  const world = new World(SIZE, BOTTOM, TOP)
  strata(world)
  surface(world)
  cellar(world)
  edgeRoom(world)
  sleepRoom(world)
  machineRoom(world)
  packsRoom(world)
  backupsRoom(world)
  runtimesRoom(world)
  fleetRoom(world)
  return world
}
