// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The files a player chose or dropped, copied out of the browser's lists while those still hold
 * them. The only place in the site that reads those lists; `apps/web/live-file-lists.grit` fails
 * the lint on a read anywhere else.
 *
 * An input's `files` is live: clearing the input, which a page does so that the same file chosen
 * again is a new choice, empties the list it gave, and Chrome empties it at once. A folder read
 * after the clear was always empty. A drop's `files` and `items` hold only while the drop's event
 * runs, so a folder walked after an `await` has to have been taken as entries first.
 *
 * Not for what is done with the files: a world folder is looked at and laid out in
 * `world-folder.ts`, and a pack or a datapack is sent by its page.
 */

/** The files an input's change chose, as a list of their own, the input cleared for the next choice. */
export function chosenFiles(event: { currentTarget: HTMLInputElement }): File[] {
  const input = event.currentTarget
  const chosen = [...(input.files ?? [])]
  input.value = ''
  return chosen
}

/** The files a drop holds, as a list of their own, taken while its event runs. */
export function droppedFiles(event: { dataTransfer: DataTransfer | null }): File[] {
  return [...(event.dataTransfer?.files ?? [])]
}

/**
 * What a drop holds as entries, folders among them, taken while its event runs, to be walked
 * after it (`droppedFrom` in `world-folder.ts`).
 */
export function droppedEntries(event: { dataTransfer: DataTransfer | null }): FileSystemEntry[] {
  return [...(event.dataTransfer?.items ?? [])]
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null)
}
