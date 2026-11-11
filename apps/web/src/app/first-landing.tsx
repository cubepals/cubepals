// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { useEffect } from 'react'
import { noteLanding } from '../lib/landing-source'

/** Notes where the first page of this tab came from, before the site's own links move on from it. */
export function FirstLanding() {
  useEffect(() => {
    noteLanding({
      search: window.location.search,
      referrer: document.referrer,
      host: window.location.hostname,
    })
  }, [])
  return null
}
