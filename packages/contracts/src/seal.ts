// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Check marks and seals in what a player types. A server's name, description and server list
 * message, and a note on its page, refuse them; the control plane refuses them and the web app
 * says so as they are typed, both from here. Tags are picked from a fixed list.
 *
 * Found: check marks, the ballot boxes and keycaps that hold one, the square root sign, and
 * medals, rosettes and badges. An emoji's variation selector follows the character it changes,
 * so `✔️` is found by its `✔`.
 */
const LOOK_ALIKES =
  /[✓✔✅☑√⍻\u{10102}\u{1f5f8}\u{1f5f9}\u{1fbb1}\u{1f3c5}\u{1f396}\u{1f3f5}\u{1f530}\u{1f4ae}\u{1f4db}\u{1f947}-\u{1f949}]/u

/** What `field` can't use, when `text` holds a check mark or a seal; null when it holds none. */
export function sealProblem(
  text: string,
  field: 'Names' | 'Descriptions' | 'Server messages' | 'Notes',
): string | null {
  return LOOK_ALIKES.test(text.normalize('NFC')) ? `${field} can’t use check marks or seals.` : null
}
