// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * Pictures can't be dragged or saved from the menu: a drag that starts on one moves nothing, and
 * a right-click on one opens no menu. Text, links, fields and everything else keep theirs.
 * globals.css stops the same elements selecting and offering iOS's long-press "Save image".
 */
import { useEffect } from 'react'

const PICTURE = 'img, picture, video, canvas, svg[role="img"], .bk-face svg'
const CONTROL = 'a, button, input, textarea, select, label, summary, [contenteditable], [tabindex]'

function onPicture(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(PICTURE) !== null
}

/**
 * Whether a right-click lands on a picture that lets the pointer through to what is beneath it,
 * such as the landing's film over its scenes. A click on text or a control there keeps its menu.
 */
function overPicture(event: MouseEvent): boolean {
  const target = event.target
  const { clientX: x, clientY: y } = event
  if (!(target instanceof Element) || target.closest(CONTROL) !== null || textAt(x, y)) return false
  return [...document.querySelectorAll(PICTURE)].some(
    (picture) =>
      getComputedStyle(picture).pointerEvents === 'none' && inside(picture.getBoundingClientRect(), x, y),
  )
}

/**
 * Whether a letter of the page's text is under the point. A browser without
 * `caretPositionFromPoint` counts every point as text, so the menu stays there.
 */
function textAt(x: number, y: number): boolean {
  if (!('caretPositionFromPoint' in document)) return true
  const caret = document.caretPositionFromPoint(x, y)
  const node = caret?.offsetNode
  const offset = caret?.offset ?? 0
  if (!(node instanceof Text)) return false
  const letter = document.createRange()
  return [offset - 1, offset].some((at) => {
    if (at < 0 || at >= node.length) return false
    letter.setStart(node, at)
    letter.setEnd(node, at + 1)
    return inside(letter.getBoundingClientRect(), x, y)
  })
}

function inside(box: DOMRect, x: number, y: number): boolean {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
}

export function KeepPictures() {
  useEffect(() => {
    // A drag from a picture inside a link is the link's drag, so the press that began it is
    // checked as well as the drag's own target.
    let pressedOnPicture = false
    const onPress = (event: PointerEvent) => {
      pressedOnPicture = onPicture(event.target)
    }
    const onDrag = (event: DragEvent) => {
      if (pressedOnPicture || onPicture(event.target)) event.preventDefault()
    }
    const onMenu = (event: MouseEvent) => {
      if (onPicture(event.target) || overPicture(event)) event.preventDefault()
    }
    document.addEventListener('pointerdown', onPress, true)
    document.addEventListener('dragstart', onDrag, true)
    document.addEventListener('contextmenu', onMenu, true)
    return () => {
      document.removeEventListener('pointerdown', onPress, true)
      document.removeEventListener('dragstart', onDrag, true)
      document.removeEventListener('contextmenu', onMenu, true)
    }
  }, [])
  return null
}
