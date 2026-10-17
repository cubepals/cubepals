// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Links on a server's volume, where Blockly's start steps write as root. Anything running on the
 * server (a plugin or mod, as the server's own user) can leave a link on the volume, and a root step
 * writing or removing through it would act outside the volume. Blockly never puts a link there
 * itself, so a step replaces any it finds on the way to a path it writes or removes, and says so in
 * the server's log; what the link pointed at is left as it was. Not which paths a step writes.
 */

import { DATA_DIR } from './jars.ts'

/**
 * A shell function, `unlinked <path>`, for a path under the volume: each link on the way to it, the
 * path itself included, is removed, so what follows writes a plain file or folder inside the
 * volume. With no link left on the way, the path can't lead outside it. A start's script defines it
 * before its first step (`runtime-spec.ts`).
 */
export const UNLINKED = [
  `unlinked() { lp=${DATA_DIR}; lr=$1; while [ -n "$lr" ]; do lp="$lp/\${lr%%/*}";`,
  `case "$lr" in */*) lr=\${lr#*/};; *) lr=;; esac;`,
  `if [ -L "$lp" ]; then rm -f "$lp" && echo "Cubepals replaced a link at \${lp#${DATA_DIR}/}" >&2; fi; done; };`,
].join(' ')
