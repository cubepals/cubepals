// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useEffect } from 'react'

/**
 * Pictures can't be dragged or saved from the menu: a drag that starts on one moves nothing, and
 * a right-click on one opens no menu. Text, links, fields and everything else keep theirs.
 * globals.css stops the same elements selecting and offering iOS's long-press "Save image".
 */
const PICTURE = 'img, picture, video, canvas, svg[role="img"], .bk-face svg'

function onPicture(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(PICTURE) !== null
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
      if (onPicture(event.target)) event.preventDefault()
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
