// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Draws a voxel world as a one-bit print, from any angle: every surface is either ink or paper,
 * with a third colour for anything lit from within. Two passes at a low resolution, scaled up
 * without smoothing so each drawn pixel stays a square.
 *
 * Pass one writes, for every pixel, how bright the surface there is, how much lamplight reaches
 * it, and which flat plane it belongs to. Pass two turns brightness into dots with an ordered
 * dither and draws an ink line wherever two different planes meet, so blocks that lie flat
 * together read as one surface and every corner reads as a corner.
 */
import { PRINT_FRAG, PRINT_VERT } from './print-pass'
import { MAX_LIGHTS, SCENE_FRAG, SCENE_VERT } from './scene-pass'
import type { Light } from './world'

export type Rgb = readonly [number, number, number]

/** The colours of a print: the dark dot, the light dot and the line. */
export interface Palette {
  low: Rgb
  high: Rgb
  line: Rgb
}

/** What one frame needs to know. Colours are 0–1 RGB. */
export interface Frame {
  /** The camera: world to clip space, column-major, as WebGL takes it. */
  camera: Float32Array
  /** How far the whole picture is slid across and up the screen, in half-screens. */
  shift: readonly [number, number]
  /** How much daylight a face gets, by the way it faces: up, +x, +z, down, −x, −z. */
  faceLight: readonly number[]
  /** What's left of that light in a shadow, 0–1. */
  shadow: number
  /** How many steps of grey the print has between ink and paper. */
  levels: number
  /** How much of each material's own grain is drawn, 0 to 1. */
  detail: number
  /** How far the rock under the grass is lifted toward bare paper, 0 to 1. */
  rock?: number
  /** How bright each light switch is, 0–1: sixteen of them. Switch 0 is unused. */
  groups: ArrayLike<number>
  /** The palettes a print can be in: the sky, the light ground, the dark ground, the night. */
  bands: readonly [Palette, Palette, Palette, Palette]
  /**
   * The drawn rows, counted from the top, where the page behind changes colour (four of them,
   * rising; the ones not needed are far below the picture), and which palette each of the five
   * stretches they make is printed in.
   */
  edges: readonly [number, number, number, number]
  regions: readonly [number, number, number, number, number]
  warm: Rgb
  /**
   * A light that isn't part of the world (a torch somebody carries, the server's own glow): where
   * it is, how far it reaches, how bright, and whose it is (1 out of doors, or a room's switch).
   */
  torch: readonly [number, number, number, number, number, number] | null
  time: number
  /** The range of world height in view, to choose which lights count. */
  viewY: readonly [number, number]
  /** The block the cursor is on, or null. */
  pick: readonly [number, number, number] | null
  /**
   * Which of the world's blocks to draw, as runs of the packed list (first block, how many): the
   * layers the camera can see, and whatever digging has uncovered since.
   */
  runs: readonly (readonly [number, number])[]
  /**
   * Which of the far worlds' faces to draw, as runs of their packed list: the first, how many, and
   * which of the five faces kept they are (0 to 4).
   */
  farRuns: readonly (readonly [number, number, number])[]
  /** Where the camera's eye is, and how far off the far worlds start to fade and are gone by. */
  eye: readonly [number, number, number]
  fog: readonly [number, number]
  /** How much of the other worlds is there, 0 to 1: they spread outward from this one. */
  crowd: number
}

export interface Packed {
  positions: Float32Array
  data: Uint8Array
  count: number
  /** For loose parts only: how each is turned about its middle, two angles a part (round, tipped). */
  turns?: Float32Array
}

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
function quad(face: number, corners: [number, number, number][]) {
  const uvs: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]
  for (const i of [0, 1, 2, 0, 2, 3]) {
    const corner = corners[i] as [number, number, number]
    const uv = uvs[i] as [number, number]
    FACES.push(corner[0], corner[1], corner[2], face, uv[0], uv[1])
  }
}
quad(0, [
  [0, 1, 0],
  [1, 1, 0],
  [1, 1, 1],
  [0, 1, 1],
])
quad(1, [
  [1, 0, 1],
  [1, 0, 0],
  [1, 1, 0],
  [1, 1, 1],
])
quad(2, [
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
])
quad(3, [
  [0, 0, 0],
  [1, 0, 0],
  [1, 0, 1],
  [0, 0, 1],
])
quad(4, [
  [0, 0, 0],
  [0, 0, 1],
  [0, 1, 1],
  [0, 1, 0],
])
quad(5, [
  [1, 0, 0],
  [0, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
])

/** Floats to a corner, and the corners of the five faces a far world can show: all but its underside. */
const CORNER = 6
const NEAR_FACES = [...FACES.slice(0, 18 * CORNER), ...FACES.slice(24 * CORNER)]

/** How much light a room's own switch gives a face, by the way it faces. */
const ROOM_LIGHT = new Float32Array([1, 0.86, 0.64, 0.5, 0.7, 0.78])

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
}

export class Renderer {
  private readonly gl: WebGL2RenderingContext
  private readonly scene: WebGLProgram
  private readonly print: WebGLProgram
  private readonly corners: WebGLBuffer
  private readonly nearCorners: WebGLBuffer
  private readonly still: Batch
  private readonly moving: Batch
  private readonly far: Batch
  private readonly sceneUniforms = new Map<string, WebGLUniformLocation | null>()
  private readonly printUniforms = new Map<string, WebGLUniformLocation | null>()
  private target: {
    fb: WebGLFramebuffer
    shade: WebGLTexture
    plane: WebGLTexture
    depth: WebGLRenderbuffer
  } | null = null
  private lights: Light[] = []
  // What a frame hands the shaders, kept between frames so drawing allocates nothing.
  private readonly faceLight = new Float32Array(6)
  private readonly groups = new Float32Array(16)
  private readonly lightWhere = new Float32Array(MAX_LIGHTS * 4)
  private readonly lightOn = new Float32Array(MAX_LIGHTS)
  private readonly lightOwner = new Float32Array(MAX_LIGHTS)
  private readonly low = new Float32Array(12)
  private readonly high = new Float32Array(12)
  private readonly line = new Float32Array(12)
  private readonly regions = new Int32Array(5)
  width = 1
  height = 1

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
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
    const scene = link(gl, SCENE_VERT, SCENE_FRAG)
    const print = link(gl, PRINT_VERT, PRINT_FRAG)
    this.scene = linked(gl, scene)
    this.print = linked(gl, print)
    // What never changes is said once: the light a room's switch gives each face, and which
    // texture is which.
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(this.scene)
    gl.uniform1fv(this.at(this.scene, 'uRoom'), ROOM_LIGHT)
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(this.print)
    gl.uniform1i(this.at(this.print, 'uShade'), 0)
    gl.uniform1i(this.at(this.print, 'uPlane'), 1)
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
    this.still = this.batch(corners, 36)
    this.moving = this.batch(corners, 36, true)
    // The far worlds are never seen from underneath, so five faces of each block are enough.
    this.far = this.batch(nearCorners, 30)
  }

  private batch(corners: WebGLBuffer, count: number, turned = false): Batch {
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
    gl.bindVertexArray(null)
    return { vao, positions, data, count: 0, corners: count, room: 0, turns, turnsRoom: 0 }
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
    gl.drawArraysInstanced(gl.TRIANGLES, from, corners, count)
  }

  /** The world itself. Sent again whenever a block is dug out or put back. */
  setWorld(packed: Packed, lights: Light[]): void {
    this.load(this.still, packed, this.gl.STATIC_DRAW)
    this.lights = lights
  }

  /** The other worlds round this one, seen only when the camera stands a long way back. */
  setFar(packed: Packed): void {
    this.load(this.far, packed, this.gl.STATIC_DRAW)
  }

  /** The world's light again, after the sun moved: the same blocks, new shadows. */
  relight(data: Uint8Array): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.still.data)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, this.still.count * 8))
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

  resize(width: number, height: number): void {
    const gl = this.gl
    if (width === this.width && height === this.height && this.target) return
    this.width = width
    this.height = height
    gl.canvas.width = width
    gl.canvas.height = height
    if (this.target) {
      gl.deleteFramebuffer(this.target.fb)
      gl.deleteTexture(this.target.shade)
      gl.deleteTexture(this.target.plane)
      gl.deleteRenderbuffer(this.target.depth)
    }
    const texture = () => {
      const t = gl.createTexture()
      if (!t) throw new Error('no texture')
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      return t
    }
    const shade = texture()
    const plane = texture()
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.target = { fb, shade, plane, depth }
  }

  private at(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    const known = program === this.scene ? this.sceneUniforms : this.printUniforms
    let where = known.get(name)
    if (where === undefined) {
      where = this.gl.getUniformLocation(program, name)
      known.set(name, where)
    }
    return where
  }

  draw(frame: Frame): void {
    const gl = this.gl
    const target = this.target
    if (!target) return
    const s = this.scene

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb)
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clearDepth(1)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    gl.disable(gl.BLEND)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(s)
    gl.uniformMatrix4fv(this.at(s, 'uCamera'), false, frame.camera)
    gl.uniform2f(this.at(s, 'uShift'), frame.shift[0], frame.shift[1])
    for (let i = 0; i < 6; i++) this.faceLight[i] = frame.faceLight[i] ?? 0
    gl.uniform1fv(this.at(s, 'uFace'), this.faceLight)
    gl.uniform1f(this.at(s, 'uShadow'), frame.shadow)
    gl.uniform1f(this.at(s, 'uLevels'), frame.levels)
    gl.uniform1f(this.at(s, 'uDetail'), frame.detail)
    gl.uniform1f(this.at(s, 'uRock'), frame.rock ?? 0)
    gl.uniform1f(this.at(s, 'uTime'), frame.time)
    if (frame.pick) gl.uniform3f(this.at(s, 'uPick'), frame.pick[0], frame.pick[1], frame.pick[2])
    else gl.uniform3f(this.at(s, 'uPick'), -999, -999, -999)
    const groups = this.groups
    for (let i = 0; i < 16; i++) groups[i] = frame.groups[i] ?? 0
    gl.uniform1fv(this.at(s, 'uGroups'), groups)

    // Only the lights that are on and near what's in view: a chunk has more than a shader wants.
    let lit = 0
    for (const light of this.lights) {
      if (lit === MAX_LIGHTS) break
      const level = groups[light.group] ?? 0
      if (level <= 0 || light.y < frame.viewY[0] - light.radius || light.y > frame.viewY[1] + light.radius)
        continue
      this.lightWhere[lit * 4] = light.x
      this.lightWhere[lit * 4 + 1] = light.y
      this.lightWhere[lit * 4 + 2] = light.z
      this.lightWhere[lit * 4 + 3] = light.radius
      this.lightOn[lit] = level
      this.lightOwner[lit] = light.group
      lit += 1
    }
    // A loose light is one more of them, wherever it is this frame.
    if (frame.torch && frame.torch[4] > 0 && lit < MAX_LIGHTS) {
      this.lightWhere[lit * 4] = frame.torch[0]
      this.lightWhere[lit * 4 + 1] = frame.torch[1]
      this.lightWhere[lit * 4 + 2] = frame.torch[2]
      this.lightWhere[lit * 4 + 3] = frame.torch[3]
      this.lightOn[lit] = frame.torch[4]
      this.lightOwner[lit] = frame.torch[5]
      lit += 1
    }
    gl.uniform4fv(this.at(s, 'uLights'), this.lightWhere)
    gl.uniform1fv(this.at(s, 'uLightOn'), this.lightOn)
    gl.uniform1fv(this.at(s, 'uLightGroup'), this.lightOwner)
    gl.uniform1i(this.at(s, 'uLightCount'), lit)
    gl.uniform3f(this.at(s, 'uEye'), frame.eye[0], frame.eye[1], frame.eye[2])

    // The world: only the runs of it the camera can see.
    gl.uniform2f(this.at(s, 'uWave'), 0, 0)
    gl.uniform1f(this.at(s, 'uLoose'), 0)
    gl.uniform3f(this.at(s, 'uFog'), frame.fog[0], frame.fog[1], 0)
    gl.uniform1f(this.at(s, 'uNudge'), 0)
    for (const [first, count] of frame.runs)
      this.run(this.still, first, Math.min(count, this.still.count - first))
    // What moves is drawn a hair nearer, so a light set into a rack shows over the rack.
    gl.uniform1f(this.at(s, 'uNudge'), 0.0004)
    gl.uniform1f(this.at(s, 'uLoose'), 1)
    this.run(this.moving, 0, this.moving.count)
    gl.uniform1f(this.at(s, 'uLoose'), 0)
    if (frame.crowd > 0.004 && this.far.count > 0) {
      // The far worlds: the ring's edge, and how wide the band is in which blocks are still growing.
      gl.uniform1f(this.at(s, 'uNudge'), 0)
      gl.uniform2f(this.at(s, 'uWave'), frame.crowd * 330, 60)
      gl.uniform3f(this.at(s, 'uFog'), frame.fog[0], frame.fog[1], 1)
      for (const [first, count, slot] of frame.farRuns)
        this.run(this.far, first, Math.min(count, this.far.count - first), slot * 6, 6)
    }
    gl.bindVertexArray(null)

    const p = this.print
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.disable(gl.DEPTH_TEST)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(p)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, target.shade)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, target.plane)
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
    gl.uniform4f(this.at(p, 'uEdges'), frame.edges[0], frame.edges[1], frame.edges[2], frame.edges[3])
    this.regions.set(frame.regions)
    gl.uniform1iv(this.at(p, 'uRegions'), this.regions)
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
    }
    gl.deleteBuffer(this.corners)
    gl.deleteBuffer(this.nearCorners)
    gl.deleteProgram(this.scene)
    gl.deleteProgram(this.print)
    if (this.target) {
      gl.deleteFramebuffer(this.target.fb)
      gl.deleteTexture(this.target.shade)
      gl.deleteTexture(this.target.plane)
      gl.deleteRenderbuffer(this.target.depth)
      this.target = null
    }
  }
}
