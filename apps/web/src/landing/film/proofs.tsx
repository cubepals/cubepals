// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: LicenseRef-Cubepals-Reserved

'use client'

/**
 * The beats' proofs (sections/), loaded apart from the film: a proof is mounted only when its "How
 * it works" is opened, so none of their code is in the first load. Once the page has loaded and
 * gone quiet they are fetched (`WarmProofs`), so one opens at once all the same.
 */
import dynamic from 'next/dynamic'
import { useEffect } from 'react'

const load = {
  address: () => import('../sections/Address').then((part) => part.Address),
  ledger: () => import('../sections/Ledger').then((part) => part.Ledger),
  sleep: () => import('../sections/Sleep').then((part) => part.Sleep),
  machine: () => import('../sections/Machine').then((part) => part.Machine),
  packs: () => import('../sections/Packs').then((part) => part.Packs),
  backups: () => import('../sections/Backups').then((part) => part.Backups),
  runtimes: () => import('../sections/Runtimes').then((part) => part.Runtimes),
  fleet: () => import('../sections/Fleet').then((part) => part.Fleet),
}

export const AddressProof = dynamic(load.address)
export const LedgerProof = dynamic(load.ledger)
export const SleepProof = dynamic(load.sleep)
export const MachineProof = dynamic(load.machine)
export const PacksProof = dynamic(load.packs)
export const BackupsProof = dynamic(load.backups)
export const RuntimesProof = dynamic(load.runtimes)
export const FleetProof = dynamic(load.fleet)

/** Fetches every proof's code a few seconds after the page has loaded. */
export function WarmProofs() {
  useEffect(() => {
    let timer = 0
    const warm = () => {
      timer = window.setTimeout(() => {
        for (const fetch of Object.values(load)) void fetch()
      }, 4000)
    }
    if (document.readyState === 'complete') warm()
    else window.addEventListener('load', warm, { once: true })
    return () => {
      window.removeEventListener('load', warm)
      clearTimeout(timer)
    }
  }, [])
  return null
}
