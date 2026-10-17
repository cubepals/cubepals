// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Draws a voxel world as a one-bit print, from any angle: every surface is either ink or paper,
 * with a third colour for anything lit from within. It is lit first and printed after, so the
 * print carries depth. The passes run at a low resolution, scaled up without smoothing so each
 * drawn dot stays a square.
 *
 * The shadow map is drawn from the key light, and only again when the light moves or the world
 * changes. Pass one lights every pixel and writes how bright it is, whether it glows, and which
 * flat plane it belongs to (scene-pass.ts). What glows is blurred, one way and then the other.
 * Pass two turns brightness into dots through a tone curve and an ordered dither, and draws a
 * line wherever two different planes meet, so blocks that lie flat together read as one surface
 * and every corner reads as a corner (print-pass.ts). The light that doesn't move is baked into a
 * grid when the world is sent (bake.ts) and read by pass one from a 3D texture (volume.ts).
 */
import { baked } from './bake'
import type { Vec3 } from './camera'
import type { Frame, Packed, Palette } from './frame'
import { Maps } from './maps'
import { GLOW_FRAG, PRINT_FRAG, PRINT_VERT } from './print-pass'
import { MAX_LIGHTS, QUICK_FRAG, SCENE_FRAG, SCENE_VERT, SHADOW_FRAG } from './scene-pass'
import { lampMatrix, lightMatrix, MAP_SIZE } from './shadow'
import { Volume } from './volume'
import { CORNERS, type World } from './world'

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('no shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  return shader
}

/** A program set compiling and linking, and not yet waited for. */
interface Linking {
  program: WebGLProgram
  vertex: WebGLShader
  fragment: WebGLShader
}

/**
 * Sets a program compiling and linking and comes straight back. Asking how a shader did makes the
 * browser wait for it there and then, so nothing is asked until every program is under way
 * (`linked`), and the driver can work on all of them at once.
 */
function link(gl: WebGL2RenderingContext, vert: string, frag: string): Linking {
  const program = gl.createProgram()
  if (!program) throw new Error('no program')
  const vertex = compile(gl, gl.VERTEX_SHADER, vert)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, frag)
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  return { program, vertex, fragment }
}

/** Waits for a program, and says why if it didn't link: its own log, or a shader's. */
function linked(gl: WebGL2RenderingContext, { program, vertex, fragment }: Linking): WebGLProgram {
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(
      gl.getProgramInfoLog(program) || gl.getShaderInfoLog(vertex) || gl.getShaderInfoLog(fragment) || 'link',
    )
  // Flagged now, they are freed with the program they belong to.
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  return program
}

// A block's six faces, two triangles each: corner, face, and where on the face. The faces are in
// the world's order: up, +x, +z, down, −x, −z.
const FACES: number[] = []
const UVS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const
CORNERS.forEach((corners, face) => {
  for (const i of [0, 1, 2, 0, 2, 3]) {
    const corner = corners[i] as readonly [number, number, number]
    const uv = UVS[i] as readonly [number, number]
    FACES.push(corner[0], corner[1], corner[2], face, uv[0], uv[1])
  }
})

/** Floats to a corner, and the corners of the five faces a far world can show: all but its underside. */
const CORNER = 6
const NEAR_FACES = [...FACES.slice(0, 18 * CORNER), ...FACES.slice(24 * CORNER)]

/** How much light a room's own switch gives a face, by the way it faces. */
const ROOM_LIGHT = new Float32Array([1, 0.86, 0.64, 0.5, 0.7, 0.78])

/** The KHR_parallel_shader_compile extension's COMPLETION_STATUS_KHR, which WebGL names nowhere. */
const COMPLETION_STATUS_KHR = 0x91b1

/** The programs: the quick look's three, which the first frames are drawn with, and the lit look's. */
type Program = 'quick' | 'print' | 'blur' | 'scene' | 'shadow'
const QUICK: readonly Program[] = ['quick', 'print', 'blur']
const LIT: readonly Program[] = ['scene', 'shadow']

/** Every corner of every face open: what a part without shading of its own is drawn with. */
const OPEN = 0xffffffff

interface Batch {
  vao: WebGLVertexArrayObject
  positions: WebGLBuffer
  data: WebGLBuffer
  count: number
  /** How many corners a block of this batch is drawn with: 36 for a whole cube, 30 without its underside. */
  corners: number
  /** How many blocks its buffers have room for, so a smaller load can reuse them. */
  room: number
  /** How its parts are turned, for the batch of loose parts; a block of the world is never turned. */
  turns: WebGLBuffer | null
  turnsRoom: number
  /** How its corners are shaded, for the world's own blocks. */
  ao: WebGLBuffer | null
}

/** The textures a frame is drawn into before it is printed, at the print's own size. */
interface Target {
  fb: WebGLFramebuffer
  shade: WebGLTexture
  plane: WebGLTexture
  depth: WebGLRenderbuffer
  /** What glows, blurred one way and then the other, each into a framebuffer of its own. */
  glow: [WebGLTexture, WebGLTexture]
  glowFb: [WebGLFramebuffer, WebGLFramebuffer]
}

/**
 * A canvas on the page says, with `data-lit`, once it shows the lit print, so the still printed
 * beforehand that stands in for it (`.bl-first`, FilmPage.tsx) can give way. A worker's canvas has
 * no attributes.
 */
function markLit(canvas: HTMLCanvasElement | OffscreenCanvas): void {
  if ('dataset' in canvas && !('lit' in canvas.dataset)) canvas.dataset.lit = ''
}

export class Renderer {
  private readonly gl: WebGL2RenderingContext
  /** The programs while they compile, and each once it has. */
  private readonly linking: Record<Program, Linking>
  private readonly programs: Partial<Record<Program, WebGLProgram>> = {}
  /** Whether a frame has been drawn: without the parallel compile, the lit look is waited for after it. */
  private drawn = false
  /** Whether the driver can say a program has finished compiling without being waited on. */
  private readonly parallel: boolean
  private readonly corners: WebGLBuffer
  private readonly nearCorners: WebGLBuffer
  private readonly still: Batch
  private readonly moving: Batch
  private readonly far: Batch
  private readonly uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>()
  private target: Target | null = null
  /** The shadow maps, and what the key light's was last drawn for (the light's way and the world). */
  private readonly maps: Maps
  private readonly volume: Volume
  private mapFor = ''
  private worldVersion = 0
  // What a frame hands the shaders, kept between frames so drawing allocates nothing.
  private readonly groups = new Float32Array(16)
  private readonly lightWhere = new Float32Array(MAX_LIGHTS * 4)
  private readonly lightOn = new Float32Array(MAX_LIGHTS)
  private readonly lightOwner = new Float32Array(MAX_LIGHTS)
  private readonly low = new Float32Array(12)
  private readonly high = new Float32Array(12)
  private readonly line = new Float32Array(12)
  private readonly regions = new Int32Array(5)
  private lightView: Float32Array = new Float32Array(16)
  private lampView: Float32Array = new Float32Array(16)
  width = 1
  height = 1

  /** `mapSize` is how many texels a side the shadow map has; a device short of memory can ask for fewer. */
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, mapSize = MAP_SIZE) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      // The picture is drawn into its own target and printed from there, so the canvas itself
      // needs neither depth nor stencil; and this is the page's main event, so ask for the
      // better graphics card where there are two.
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new Error('WebGL 2 is not available')
    this.gl = gl
    this.maps = new Maps(gl, mapSize)
    this.volume = new Volume(gl)
    // The programs are set compiling here and waited for only when first used, or not at all
    // where the driver can say when they are done (`ready`): the page never stops for them.
    this.parallel = gl.getExtension('KHR_parallel_shader_compile') !== null
    // The quick look first, so a frame can be drawn as soon as it is: the lit look follows.
    this.linking = {
      quick: link(gl, SCENE_VERT, QUICK_FRAG),
      print: link(gl, PRINT_VERT, PRINT_FRAG),
      blur: link(gl, PRINT_VERT, GLOW_FRAG),
      scene: link(gl, SCENE_VERT, SCENE_FRAG),
      shadow: link(gl, SCENE_VERT, SHADOW_FRAG),
    }
    const corners = gl.createBuffer()
    if (!corners) throw new Error('no buffer')
    this.corners = corners
    gl.bindBuffer(gl.ARRAY_BUFFER, corners)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(FACES), gl.STATIC_DRAW)
    const nearCorners = gl.createBuffer()
    if (!nearCorners) throw new Error('no buffer')
    this.nearCorners = nearCorners
    gl.bindBuffer(gl.ARRAY_BUFFER, nearCorners)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(NEAR_FACES), gl.STATIC_DRAW)
    this.still = this.batch(corners, 36, false, true)
    this.moving = this.batch(corners, 36, true)
    // The far worlds are never seen from underneath, so five faces of each block are enough.
    this.far = this.batch(nearCorners, 30)
    // A batch without shading of its own reads every corner as open.
    gl.vertexAttribI4ui(7, OPEN, OPEN, 0, 0)
  }

  /**
   * Whether the quick look's programs have compiled, asked without waiting where the driver
   * allows it: a frame can be drawn once they have. The lit look is swapped in when it is ready.
   */
  get ready(): boolean {
    return this.compiled(QUICK, !this.parallel)
  }

  /** Whether the lit look has compiled: until it has, frames are drawn in the quick one. */
  get lit(): boolean {
    return LIT.every((name) => this.programs[name])
  }

  /**
   * Whether these programs have compiled, each waited for and set up once it has; `wait` waits
   * for any still compiling, or else this only asks.
   */
  private compiled(names: readonly Program[], wait: boolean): boolean {
    for (const name of names) {
      if (this.programs[name]) continue
      const linking = this.linking[name]
      if (!wait && this.parallel && !this.gl.getProgramParameter(linking.program, COMPLETION_STATUS_KHR))
        return false
      this.programs[name] = this.setUp(name, linked(this.gl, linking))
    }
    return true
  }

  /** Says once what never changes in a program: room light, and which texture is which. */
  private setUp(name: Program, program: WebGLProgram): WebGLProgram {
    const gl = this.gl
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(program)
    const unit = (uniform: string, index: number) => gl.uniform1i(this.at(program, uniform), index)
    if (name === 'scene' || name === 'quick') {
      gl.uniform1fv(this.at(program, 'uRoom'), ROOM_LIGHT)
      unit('uShadowMap', 2)
      unit('uLampMap', 3)
      unit('uVolume', 4)
    }
    if (name === 'print') {
      unit('uShade', 0)
      unit('uPlane', 1)
      unit('uGlow', 2)
    }
    if (name === 'blur') unit('uFrom', 0)
    return program
  }

  /** A program, waited for if it has to be. */
  private program(name: Program): WebGLProgram {
    this.compiled([name], true)
    return this.programs[name] as WebGLProgram
  }

  private batch(corners: WebGLBuffer, count: number, turned = false, shaded = false): Batch {
    const gl = this.gl
    const vao = gl.createVertexArray()
    const positions = gl.createBuffer()
    const data = gl.createBuffer()
    if (!vao || !positions || !data) throw new Error('no buffer')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, corners)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 24, 12)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 24, 16)
    gl.bindBuffer(gl.ARRAY_BUFFER, positions)
    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 12, 0)
    gl.vertexAttribDivisor(3, 1)
    gl.bindBuffer(gl.ARRAY_BUFFER, data)
    gl.enableVertexAttribArray(4)
    gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, 8, 0)
    gl.vertexAttribDivisor(4, 1)
    gl.enableVertexAttribArray(5)
    gl.vertexAttribPointer(5, 4, gl.UNSIGNED_BYTE, true, 8, 4)
    gl.vertexAttribDivisor(5, 1)
    // Left switched off, the turn reads as none at all, which is what a block of the world has.
    let turns: WebGLBuffer | null = null
    if (turned) {
      turns = gl.createBuffer()
      if (!turns) throw new Error('no buffer')
      gl.bindBuffer(gl.ARRAY_BUFFER, turns)
      gl.enableVertexAttribArray(6)
      gl.vertexAttribPointer(6, 2, gl.FLOAT, false, 8, 0)
      gl.vertexAttribDivisor(6, 1)
    }
    let ao: WebGLBuffer | null = null
    if (shaded) {
      ao = gl.createBuffer()
      if (!ao) throw new Error('no buffer')
      gl.bindBuffer(gl.ARRAY_BUFFER, ao)
      gl.enableVertexAttribArray(7)
      gl.vertexAttribIPointer(7, 2, gl.UNSIGNED_INT, 8, 0)
      gl.vertexAttribDivisor(7, 1)
    }
    gl.bindVertexArray(null)
    return { vao, positions, data, count: 0, corners: count, room: 0, turns, turnsRoom: 0, ao }
  }

  private load(batch: Batch, packed: Packed, usage: number): void {
    const gl = this.gl
    const positions = packed.positions.subarray(0, packed.count * 3)
    const data = packed.data.subarray(0, packed.count * 8)
    // A load that fits where the last one was is written over it; the buffers are only made
    // again when there is more to hold.
    const fits = packed.count <= batch.room
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.positions)
    if (fits) gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions)
    // Made as big as the list it comes from, its room to grow included, so a block uncovered by
    // digging fits where the last load was.
    else gl.bufferData(gl.ARRAY_BUFFER, packed.positions, usage)
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.data)
    if (fits) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    else gl.bufferData(gl.ARRAY_BUFFER, packed.data, usage)
    if (batch.ao && packed.ao) {
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.ao)
      if (fits) gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed.ao.subarray(0, packed.count * 8))
      else gl.bufferData(gl.ARRAY_BUFFER, packed.ao, usage)
    }
    if (!fits) batch.room = packed.positions.length / 3
    batch.count = packed.count
  }

  /**
   * Draws some of a batch: `count` of its instances from instance `first`, each with `corners`
   * corners from corner `from`.
   */
  private run(batch: Batch, first: number, count: number, from = 0, corners = batch.corners): void {
    if (count <= 0) return
    const gl = this.gl
    gl.bindVertexArray(batch.vao)
    // The per-block columns are pointed at where the run begins.
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.positions)
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 12, first * 12)
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.data)
    gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, 8, first * 8)
    gl.vertexAttribPointer(5, 4, gl.UNSIGNED_BYTE, true, 8, first * 8 + 4)
    if (batch.ao) {
      gl.bindBuffer(gl.ARRAY_BUFFER, batch.ao)
      gl.vertexAttribIPointer(7, 2, gl.UNSIGNED_INT, 8, first * 8)
    }
    gl.drawArraysInstanced(gl.TRIANGLES, from, corners, count)
  }

  /** The world itself. Sent again whenever a block is dug out or put back. */
  setWorld(packed: Packed, world: World): void {
    this.load(this.still, packed, this.gl.STATIC_DRAW)
    this.volume.load(baked(world))
    this.worldVersion += 1
  }

  /** The other worlds round this one, seen only when the camera stands a long way back. */
  setFar(packed: Packed): void {
    this.load(this.far, packed, this.gl.STATIC_DRAW)
  }

  /** The world's light again, after the sun moved or a block grew a step: the same blocks. */
  relight(data: Uint8Array): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.still.data)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, this.still.count * 8))
    this.worldVersion += 1
  }

  /**
   * Whatever moves: people, carts, what flies off a dug block. Sent every frame it changes. These
   * are loose parts, not blocks: 3 floats for a part's low corner, then 8 bytes: tone, kind, light
   * group, how far it reaches along x, y and z (255 is two blocks), the room it is in (0 out of
   * doors), and one spare.
   */
  setMoving(packed: Packed): void {
    if (packed.count === 0 && this.moving.count === 0) return
    this.load(this.moving, packed, this.gl.DYNAMIC_DRAW)
    const gl = this.gl
    const batch = this.moving
    if (!batch.turns || !packed.turns) return
    gl.bindBuffer(gl.ARRAY_BUFFER, batch.turns)
    if (packed.count <= batch.turnsRoom)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed.turns.subarray(0, packed.count * 2))
    else {
      gl.bufferData(gl.ARRAY_BUFFER, packed.turns, gl.DYNAMIC_DRAW)
      batch.turnsRoom = packed.turns.length / 2
    }
  }

  private colourTexture(format: number, width: number, height: number): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture()
    if (!t) throw new Error('no texture')
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  private freeTarget(): void {
    const gl = this.gl
    const target = this.target
    if (!target) return
    gl.deleteFramebuffer(target.fb)
    gl.deleteTexture(target.shade)
    gl.deleteTexture(target.plane)
    gl.deleteRenderbuffer(target.depth)
    for (const texture of target.glow) gl.deleteTexture(texture)
    for (const fb of target.glowFb) gl.deleteFramebuffer(fb)
    this.target = null
  }

  resize(width: number, height: number): void {
    const gl = this.gl
    if (width === this.width && height === this.height && this.target) return
    this.width = width
    this.height = height
    gl.canvas.width = width
    gl.canvas.height = height
    this.freeTarget()
    const shade = this.colourTexture(gl.RGBA8, width, height)
    const plane = this.colourTexture(gl.RGBA8, width, height)
    const depth = gl.createRenderbuffer()
    const fb = gl.createFramebuffer()
    if (!depth || !fb) throw new Error('no framebuffer')
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, shade, 0)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, plane, 0)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
    const glow: [WebGLTexture, WebGLTexture] = [
      this.colourTexture(gl.R8, width, height),
      this.colourTexture(gl.R8, width, height),
    ]
    const glowFb = glow.map((texture) => {
      const made = gl.createFramebuffer()
      if (!made) throw new Error('no framebuffer')
      gl.bindFramebuffer(gl.FRAMEBUFFER, made)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      return made
    }) as [WebGLFramebuffer, WebGLFramebuffer]
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.target = { fb, shade, plane, depth, glow, glowFb }
  }

  private at(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    let known = this.uniforms.get(program)
    if (!known) {
      known = new Map()
      this.uniforms.set(program, known)
    }
    let where = known.get(name)
    if (where === undefined) {
      where = this.gl.getUniformLocation(program, name)
      known.set(name, where)
    }
    return where
  }

  /**
   * Draws the shadow map from the key light, if the light has moved or the world has changed since
   * it was last drawn. Only the world's blocks cast: what moves is drawn every frame and the map
   * is not, so it is lit by the map without casting into it.
   */
  private castShadows(shadows: NonNullable<Frame['shadows']>, key: Vec3): void {
    const wanted = `${key.join(',')}|${shadows.middle.join(',')}|${shadows.radius}|${this.worldVersion}`
    if (wanted === this.mapFor) return
    this.mapFor = wanted
    this.lightView = lightMatrix(key, shadows.middle, shadows.radius)
    this.maps.drawKey()
    this.cast(this.lightView, shadows.runs, 0, false)
  }

  /**
   * Draws the room lamp's map from where the lamp is, every frame: what moves in the room casts
   * into it as well as the room itself.
   */
  private castLamp(frame: Frame, torch: NonNullable<Frame['torch']>): void {
    this.lampView = lampMatrix([torch[0], torch[1], torch[2]])
    this.maps.drawLamp()
    this.cast(this.lampView, frame.runs, frame.time, true)
  }

  /** Draws what casts into a map, as seen through `view`: the world's runs, and what moves too. */
  private cast(view: Float32Array, runs: Frame['runs'], time: number, moving: boolean): void {
    const gl = this.gl
    const s = this.program('shadow')
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(s)
    gl.uniformMatrix4fv(this.at(s, 'uCamera'), false, view)
    gl.uniform2f(this.at(s, 'uShift'), 0, 0)
    gl.uniform2f(this.at(s, 'uWave'), 0, 0)
    gl.uniform1f(this.at(s, 'uNudge'), 0)
    gl.uniform1f(this.at(s, 'uTime'), time)
    gl.uniform3f(this.at(s, 'uFog'), 0, 1, 0)
    gl.uniform1f(this.at(s, 'uLoose'), 0)
    for (const [first, count] of runs) this.run(this.still, first, Math.min(count, this.still.count - first))
    if (moving) {
      gl.uniform1f(this.at(s, 'uLoose'), 1)
      this.run(this.moving, 0, this.moving.count)
    }
    gl.bindVertexArray(null)
  }

  /** The lights that are on and near what's in view, the carried one too: a chunk has more than a shader wants. */
  private gatherLights(frame: Frame): number {
    let lit = 0
    const put = (x: number, y: number, z: number, radius: number, on: number, owner: number) => {
      this.lightWhere.set([x, y, z, radius], lit * 4)
      this.lightOn[lit] = on
      this.lightOwner[lit] = owner
      lit += 1
    }
    const torch = frame.torch
    if (torch && torch[4] > 0 && lit < MAX_LIGHTS)
      put(torch[0], torch[1], torch[2], torch[3], torch[4], torch[5])
    return lit
  }

  /**
   * Draws a frame: in the lit look once its programs have compiled, and in the quick look (no
   * shadows, no lamps) until then. Says which, so the caller draws again until it is lit. `wait`
   * waits for the lit look instead, for a picture printed once.
   */
  draw(frame: Frame, wait = false): boolean {
    const gl = this.gl
    const target = this.target
    if (!target) return false
    const lit = this.compiled(LIT, wait || (!this.parallel && this.drawn))
    this.drawn = true
    const s = this.program(lit ? 'scene' : 'quick')
    for (let i = 0; i < 16; i++) this.groups[i] = frame.groups[i] ?? 0
    const shadows = lit ? frame.shadows : null
    if (shadows) this.castShadows(shadows, frame.key)
    const count = this.gatherLights(frame)
    const torch = lit ? this.lampOf(frame, count) : -1

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clearDepth(1)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    gl.disable(gl.BLEND)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    this.sceneUniforms(s, frame, torch, count)
    // The world: only the runs of it the camera can see.
    gl.uniform1i(this.at(s, 'uMapped'), shadows ? 1 : 0)
    gl.uniform2f(this.at(s, 'uWave'), 0, 0)
    gl.uniform1f(this.at(s, 'uLoose'), 0)
    gl.uniform3f(this.at(s, 'uFog'), frame.fog[0], frame.fog[1], frame.worldFog ?? 0)
    gl.uniform1f(this.at(s, 'uNudge'), 0)
    for (const [first, count] of frame.runs)
      this.run(this.still, first, Math.min(count, this.still.count - first))
    // What moves is drawn a hair nearer, so a light set into a rack shows over the rack.
    gl.uniform1f(this.at(s, 'uNudge'), 0.0004)
    gl.uniform1f(this.at(s, 'uLoose'), 1)
    this.run(this.moving, 0, this.moving.count)
    gl.uniform1f(this.at(s, 'uLoose'), 0)
    if (frame.crowd > 0.004 && this.far.count > 0) this.drawFar(s, frame)
    gl.bindVertexArray(null)
    gl.disable(gl.DEPTH_TEST)
    this.blurGlow(target, frame.unit)
    this.printFrame(target, frame)
    if (lit) markLit(gl.canvas)
    return lit
  }

  /**
   * Which of the lights is a room's own lamp (not out of doors, switch 1), the carried one, last:
   * it casts shadows, from a map of its own drawn now. −1 where there is none.
   */
  private lampOf(frame: Frame, count: number): number {
    const torch = frame.torch
    if (!torch || torch[5] === 1 || torch[4] <= 0) return -1
    this.castLamp(frame, torch)
    return count - 1
  }

  /**
   * The far worlds: the ring's edge, and how wide the band is in which blocks are still growing.
   * The map doesn't reach them; their own bits say where the key falls.
   */
  private drawFar(s: WebGLProgram, frame: Frame): void {
    const gl = this.gl
    gl.uniform1i(this.at(s, 'uMapped'), 0)
    gl.uniform4f(this.at(s, 'uVolume3'), 0, 0, 0, 0)
    gl.uniform1f(this.at(s, 'uNudge'), 0)
    gl.uniform2f(this.at(s, 'uWave'), frame.crowd * 330, 60)
    gl.uniform3f(this.at(s, 'uFog'), frame.fog[0], frame.fog[1], 1)
    for (const [first, count, slot] of frame.farRuns)
      this.run(this.far, first, Math.min(count, this.far.count - first), slot * 6, 6)
  }

  /** What the scene pass is told of a frame: its camera, its light, its lamps and its maps. */
  private sceneUniforms(s: WebGLProgram, frame: Frame, torch: number, count: number): void {
    const gl = this.gl
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(s)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.maps.key)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.maps.lamp)
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_3D, this.volume.texture)
    gl.uniform4f(this.at(s, 'uVolume3'), ...this.volume.size, this.volume.bottom)
    gl.uniform1i(this.at(s, 'uTorch'), torch)
    gl.uniformMatrix4fv(this.at(s, 'uLampView'), false, this.lampView)
    gl.uniform1f(this.at(s, 'uRoomFill'), frame.roomFill)
    gl.uniform1f(this.at(s, 'uLampGain'), frame.lampGain)
    gl.uniform1f(this.at(s, 'uDeep'), frame.deep)
    gl.uniform1f(this.at(s, 'uAmbient'), frame.ambient)
    gl.uniform1f(this.at(s, 'uWindows'), frame.windows)
    gl.uniformMatrix4fv(this.at(s, 'uCamera'), false, frame.camera)
    gl.uniform2f(this.at(s, 'uShift'), frame.shift[0], frame.shift[1])
    gl.uniform3f(this.at(s, 'uKey'), frame.key[0], frame.key[1], frame.key[2])
    gl.uniform1f(this.at(s, 'uKeyLight'), frame.keyLight)
    gl.uniform1f(this.at(s, 'uFill'), frame.fill)
    gl.uniformMatrix4fv(this.at(s, 'uLight'), false, this.lightView)
    gl.uniform1f(this.at(s, 'uMapTexel'), this.maps.keyTexel)
    gl.uniform1f(this.at(s, 'uDetail'), frame.detail)
    gl.uniform1f(this.at(s, 'uRock'), frame.rock ?? 0)
    gl.uniform1f(this.at(s, 'uTime'), frame.time)
    if (frame.pick) gl.uniform3f(this.at(s, 'uPick'), frame.pick[0], frame.pick[1], frame.pick[2])
    else gl.uniform3f(this.at(s, 'uPick'), -999, -999, -999)
    gl.uniform1fv(this.at(s, 'uGroups'), this.groups)
    gl.uniform4fv(this.at(s, 'uLights'), this.lightWhere)
    gl.uniform1fv(this.at(s, 'uLightOn'), this.lightOn)
    gl.uniform1fv(this.at(s, 'uLightGroup'), this.lightOwner)
    gl.uniform1i(this.at(s, 'uLightCount'), count)
    gl.uniform3f(this.at(s, 'uEye'), frame.eye[0], frame.eye[1], frame.eye[2])
  }

  /** What glows, blurred across and then down: about seven CSS pixels between taps. */
  private blurGlow(target: Target, unit: number): void {
    const gl = this.gl
    const b = this.program('blur')
    const step = 7 / Math.max(0.25, unit)
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(b)
    gl.viewport(0, 0, this.width, this.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.glowFb[0])
    gl.bindTexture(gl.TEXTURE_2D, target.shade)
    gl.uniform1i(this.at(b, 'uChannel'), 1)
    gl.uniform2f(this.at(b, 'uStep'), step, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.glowFb[1])
    gl.bindTexture(gl.TEXTURE_2D, target.glow[0])
    gl.uniform1i(this.at(b, 'uChannel'), 0)
    gl.uniform2f(this.at(b, 'uStep'), 0, step)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private printFrame(target: Target, frame: Frame): void {
    const gl = this.gl
    const p = this.program('print')
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(p)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, target.shade)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, target.plane)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, target.glow[1])
    gl.uniform2i(this.at(p, 'uSize'), this.width, this.height)
    for (let index = 0; index < 4; index++) {
      const band = frame.bands[index] as Palette
      this.low.set(band.low, index * 3)
      this.high.set(band.high, index * 3)
      this.line.set(band.line, index * 3)
    }
    gl.uniform3fv(this.at(p, 'uLow'), this.low)
    gl.uniform3fv(this.at(p, 'uHigh'), this.high)
    gl.uniform3fv(this.at(p, 'uLine'), this.line)
    gl.uniform3f(this.at(p, 'uWarm'), frame.warm[0], frame.warm[1], frame.warm[2])
    gl.uniform3f(this.at(p, 'uStar'), frame.star[0], frame.star[1], frame.star[2])
    gl.uniform4f(this.at(p, 'uEdges'), frame.edges[0], frame.edges[1], frame.edges[2], frame.edges[3])
    this.regions.set(frame.regions)
    gl.uniform1iv(this.at(p, 'uRegions'), this.regions)
    gl.uniform1f(this.at(p, 'uExposure'), frame.exposure)
    gl.uniform1f(this.at(p, 'uContrast'), frame.contrast)
    gl.uniform1f(this.at(p, 'uLevels'), frame.levels)
    gl.uniform1f(this.at(p, 'uStars'), frame.stars ? 1 : 0)
    gl.uniform1f(this.at(p, 'uTime'), frame.time)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  /**
   * Frees what this renderer made. The context itself stays: a canvas only ever has one, and
   * React mounts an effect twice in development, so the next renderer needs it alive.
   */
  dispose(): void {
    const gl = this.gl
    for (const batch of [this.still, this.moving, this.far]) {
      gl.deleteVertexArray(batch.vao)
      gl.deleteBuffer(batch.positions)
      gl.deleteBuffer(batch.data)
      if (batch.turns) gl.deleteBuffer(batch.turns)
      if (batch.ao) gl.deleteBuffer(batch.ao)
    }
    gl.deleteBuffer(this.corners)
    gl.deleteBuffer(this.nearCorners)
    for (const { program } of Object.values(this.linking)) gl.deleteProgram(program)
    this.maps.dispose()
    this.volume.dispose()
    this.freeTarget()
  }
}
