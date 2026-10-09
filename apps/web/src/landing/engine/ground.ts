/**
 * What is stood on. Every frame, whoever and whatever is drawn resting on the chunk's blocks (a
 * figure's feet, a sheep, the tower, the server, a chest set down) says where, and the blocks
 * under it and round it are kept for that frame: they can't be dug, and one already dug out comes
 * back as someone comes to it. Nobody is left standing on nothing.
 */
import { BOTTOM, SIZE, TOP } from './chunk'

const LEVELS = TOP - BOTTOM + 1

export class Ground {
  /** For each block, the last frame something stood on it or beside it. */
  private readonly seen = new Uint32Array(SIZE * SIZE * LEVELS)
  private frame = 1

  /** A new frame: nothing is stood on until it says so again. */
  next(): void {
    this.frame += 1
  }

  /**
   * A loose box, as it is drawn: its low corner and how far it reaches. If it rests on a level
   * of blocks, the block under its middle is stood on, and so are the eight round that one, so
   * the ground is there a step before anyone reaches it.
   */
  rest(x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
    const level = Math.round(y)
    if (Math.abs(y - level) > 0.13 || sy < 0.08) return
    const under = level - 1
    if (under < BOTTOM || under > TOP) return
    const cx = Math.floor(x + sx / 2)
    const cz = Math.floor(z + sz / 2)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const bx = cx + dx
        const bz = cz + dz
        if (bx < 0 || bx >= SIZE || bz < 0 || bz >= SIZE) continue
        this.seen[(under - BOTTOM) * SIZE * SIZE + bz * SIZE + bx] = this.frame
      }
  }

  /** Whether the block is stood on, or beside what is, this frame. */
  has(x: number, y: number, z: number): boolean {
    if (x < 0 || x >= SIZE || z < 0 || z >= SIZE || y < BOTTOM || y > TOP) return false
    return this.seen[(y - BOTTOM) * SIZE * SIZE + z * SIZE + x] === this.frame
  }
}
