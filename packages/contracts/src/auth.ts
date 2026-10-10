// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How people can sign in on this deployment, for the sign-in and sign-up pages. Email and
 * password always work; Google and GitHub appear only where the deployment has an OAuth client
 * for them.
 */
export interface AuthMethods {
  google: boolean
  github: boolean
}
