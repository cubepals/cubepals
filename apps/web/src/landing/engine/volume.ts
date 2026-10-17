// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * The baked light (bake.ts) as a 3D texture the scene pass reads, blended between cells. Until a
 * world's light is sent, one cell of open sky and no lamplight stands in, since a sampler always
 * needs a texture to read. Not how the light is worked out (bake.ts), nor how it is read
 * (scene-pass.ts).
 */
import type { Baked } from './bake'

export class Volume {
  private readonly gl: WebGL2RenderingContext
  readonly texture: WebGLTexture
  private sent: Baked | null = null
  /** The grid's size in cells, across, up and deep, and the height of its lowest cell. */
  size: [number, number, number] = [1, 1, 1]
  bottom = 0

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.texture = gl.createTexture() as WebGLTexture
    gl.bindTexture(gl.TEXTURE_3D, this.texture)
    for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R])
      gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA8,
      1,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 0, 0, 255]),
    )
  }

  /** Sends a world's baked light, once: the same light again is left as it is. */
  load(light: Baked): void {
    if (this.sent === light) return
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_3D, this.texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA8,
      light.size,
      light.height,
      light.size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      light.data,
    )
    this.size = [light.size, light.height, light.size]
    this.bottom = light.bottom
    this.sent = light
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture)
  }
}
