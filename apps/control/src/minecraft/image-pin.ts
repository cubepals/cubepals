// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Servers pinned to Cubepals' own server image (`images/minecraft-server/`), set in private
 * configuration (SERVER_IMAGE_PIN): which servers, by id, and the image each Java runs there, by
 * digest. A pinned server on a Java with an entry runs that image; every other server, and a pinned
 * one on a Java without an entry, runs the image `imageFor` names, as before. Unset, or not a pin,
 * and no server is pinned.
 *
 * Not for: which image a server runs otherwise (`imageFor`), or building the image
 * (scripts/production-server-images.ts).
 */
import { z } from 'zod'

/** An image by digest, so a later build under the same tag never changes what a pinned server runs. */
const PinnedImage = z.string().regex(/^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+(?::[\w.-]+)?@sha256:[0-9a-f]{64}$/)

export const ImagePin = z.object({
  servers: z.array(z.uuid()).min(1),
  images: z.partialRecord(z.enum(['8', '17', '21', '25']), PinnedImage),
})
export type ImagePin = z.infer<typeof ImagePin>

/**
 * SERVER_IMAGE_PIN read: none when it is unset or empty, and none, said once through `warn`, when
 * it is not a pin, so a mistake in it pins nothing rather than stopping the control plane.
 */
export function imagePinOf(value: string | undefined, warn: (line: string) => void): ImagePin | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    warn('SERVER_IMAGE_PIN is not JSON; no server is pinned to Cubepals’ own image.')
    return null
  }
  const pin = ImagePin.safeParse(parsed)
  if (pin.success) return pin.data
  const where = pin.error.issues.map((issue) => issue.path.join('.') || '(the value)').join(', ')
  warn(`SERVER_IMAGE_PIN is not a pin (${where}); no server is pinned to Cubepals’ own image.`)
  return null
}

/** The image a pinned server runs on `java`, or null where the pin doesn't name one for it. */
export function pinnedImage(pin: ImagePin | null | undefined, serverId: string, java: number): string | null {
  if (!pin?.servers.includes(serverId)) return null
  return pin.images[String(java) as keyof ImagePin['images']] ?? null
}
