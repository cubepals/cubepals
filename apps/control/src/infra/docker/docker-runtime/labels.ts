// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Names the labels that mark a container, a volume, a snapshot or an install as one deployment's,
 * which is how every listing here finds what is Blockly's. It does not decide what a label is set
 * to or when it is read: the verbs (`docker-runtime.ts`) and the parts that make resources do.
 */

export const LABEL_DEPLOYMENT = 'blockly.deployment'
export const LABEL_SERVER = 'blockly.server'
export const LABEL_DIGEST = 'blockly.spec-digest'
export const LABEL_SNAPSHOT = 'blockly.snapshot-of'
/** On a volume holding an install made once for every server that shares it (InstallSeed). */
export const LABEL_INSTALL = 'blockly.install'
/** The stop timeout a container was made with, which a graceful stop waits out. */
export const LABEL_STOP_TIMEOUT = 'blockly.stop-timeout'
/** The ports a container was made with, both sides, so a handle can be read back from it. */
export const LABEL_PORTS = 'blockly.ports'
