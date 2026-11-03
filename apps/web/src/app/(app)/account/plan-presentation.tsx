// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

/** The deployment's Bedrock availability, passed from the server to the account's pricing cards. */
import { createContext, type ReactNode, useContext } from 'react'

const PlanPresentation = createContext(false)

export function PlanPresentationProvider({ bedrock, children }: { bedrock: boolean; children: ReactNode }) {
  return <PlanPresentation.Provider value={bedrock}>{children}</PlanPresentation.Provider>
}

export const usePlanPresentation = () => useContext(PlanPresentation)
