// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/**
 * A line whose words change in place, said the way the product says a change of a live line: the
 * old words lift away as the new ones settle (`.bk-prov__said`, as the server page's boot line
 * does). Each change shows as it comes, and the first words are simply there. Not for a line that
 * may change faster than it can be read: the boot line holds each one first.
 */
import { useState } from 'react'

interface Said {
  text: string
  key: number
}

export function SaidLine({ text }: { text: string }) {
  const [said, setSaid] = useState<{ shown: Said; before: Said | null }>({
    shown: { text, key: 0 },
    before: null,
  })
  if (said.shown.text !== text) setSaid({ shown: { text, key: said.shown.key + 1 }, before: said.shown })
  return (
    <span className="bk-said">
      {said.before ? (
        <span key={said.before.key} className="bk-prov__said bk-prov__said--out" aria-hidden>
          {said.before.text}
        </span>
      ) : null}
      <span
        key={said.shown.key}
        className={said.shown.key ? 'bk-prov__said bk-prov__said--in' : 'bk-prov__said'}
      >
        {said.shown.text}
      </span>
    </span>
  )
}
