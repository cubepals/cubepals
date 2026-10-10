// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

'use client'

import { createContext, type ReactNode, useContext } from 'react'

/**
 * Whether the person reading a public page has an account. The pages themselves are the same
 * either way; it decides only where a "make one like this" link goes, so that a stranger signs
 * up and lands on the server they were about to copy rather than an empty list.
 */
const SignedIn = createContext(false)

export function ViewerProvider({ signedIn, children }: { signedIn: boolean; children: ReactNode }) {
  return <SignedIn.Provider value={signedIn}>{children}</SignedIn.Provider>
}

export const useSignedIn = (): boolean => useContext(SignedIn)

/** Where a link goes for someone who may not have an account yet. */
export const behindSignUp = (signedIn: boolean, path: string): string =>
  signedIn ? path : `/sign-up?next=${encodeURIComponent(path)}`

/**
 * Where to go first for something only an account does on a page anyone reads, like starring a
 * server: sign in, then back to the page. Someone without an account makes one from there.
 */
export const behindSignIn = (signedIn: boolean, path: string): string =>
  signedIn ? path : `/sign-in?next=${encodeURIComponent(path)}`
