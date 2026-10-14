// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

/**
 * Where the page rests on a section: the scroll position that shows the section's beginning and
 * the one that shows its end (the same, when the section fits one screen). The scrolling rides
 * from one section's end to the next one's beginning, and the camera flies between the same two
 * places, so both read them from here.
 *
 * A section's words are marked `data-stop`: they begin a little below the top of the screen and
 * end a little above its foot. `data-stop="tail"` marks words that begin with their section (the
 * first screen). A section with no mark is a scene that holds the screen for its whole length.
 */
export function stopOf(section: HTMLElement, tall: number): { start: number; end: number } {
  const box = section.getBoundingClientRect()
  const top = box.top + window.scrollY
  const mark = section.querySelector<HTMLElement>('[data-stop]')
  let start = top
  let end = top + box.height - tall
  if (mark) {
    const words = mark.getBoundingClientRect()
    const wordsTop = words.top + window.scrollY
    const first = mark.dataset.stop === 'tail'
    if (!first) start = wordsTop - tall * 0.08
    end = wordsTop + words.height - tall * (first ? 1 : 0.9)
  }
  start = Math.max(0, Math.round(start))
  return { start, end: Math.max(start, Math.round(end)) }
}
