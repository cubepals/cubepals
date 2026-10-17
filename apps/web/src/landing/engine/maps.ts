// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The renderer's two shadow maps as textures to draw depth into and read it back from: the key
 * light's, over the grass, and the room lamp's. Each is made the first time it is drawn into, and
 * until then a texel of depth stands in, since a sampler always needs a texture to read. Not what
 * is drawn into them, nor how they are read (gl.ts, scene-pass.ts).
 */
import { LAMP_MAP_SIZE } from './shadow'

interface Depth {
  texture: WebGLTexture
  fb: WebGLFramebuffer
  size: number
}

export class Maps {
  private readonly gl: WebGL2RenderingContext
  private readonly keySize: number
  /** What a map reads before it has been drawn: one texel, as far away as can be. */
  private readonly none: WebGLTexture
  private keyMap: Depth | null = null
  private lampMap: Depth | null = null

  constructor(gl: WebGL2RenderingContext, keySize: number) {
    this.gl = gl
    this.keySize = keySize
    this.none = this.texture(1)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      1,
      1,
      gl.DEPTH_COMPONENT,
      gl.UNSIGNED_INT,
      new Uint32Array([0xffffffff]),
    )
  }

  get key(): WebGLTexture {
    return this.keyMap?.texture ?? this.none
  }

  get lamp(): WebGLTexture {
    return this.lampMap?.texture ?? this.none
  }

  /** One texel of the key light's map, in the map's own units. */
  get keyTexel(): number {
    return 1 / (this.keyMap?.size ?? 1)
  }

  /** Sets the key light's map up to be drawn into, cleared. */
  drawKey(): void {
    this.keyMap ??= this.depth(this.keySize)
    this.target(this.keyMap)
  }

  /** Sets the room lamp's map up to be drawn into, cleared. */
  drawLamp(): void {
    this.lampMap ??= this.depth(LAMP_MAP_SIZE)
    this.target(this.lampMap)
  }

  private target(map: Depth): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, map.fb)
    gl.viewport(0, 0, map.size, map.size)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    gl.clearDepth(1)
    gl.clear(gl.DEPTH_BUFFER_BIT)
  }

  /** A depth texture compared as it is read, four texels at once, so each read is soft already. */
  private texture(size: number): WebGLTexture {
    const gl = this.gl
    const texture = gl.createTexture()
    if (!texture) throw new Error('no texture')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL)
    return texture
  }

  private depth(size: number): Depth {
    const gl = this.gl
    const texture = this.texture(size)
    const fb = gl.createFramebuffer()
    if (!fb) throw new Error('no framebuffer')
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0)
    gl.drawBuffers([gl.NONE])
    return { texture, fb, size }
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteTexture(this.none)
    for (const map of [this.keyMap, this.lampMap]) {
      if (!map) continue
      gl.deleteTexture(map.texture)
      gl.deleteFramebuffer(map.fb)
    }
  }
}
