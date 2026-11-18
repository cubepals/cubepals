// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a shell that unpacks an archive Cubepals keeps (a backup, a world put to rest, a move's
 * copy) tells how it is compressed: by its first four bytes, gzip's or zstd's. Every archive so far
 * is gzip; readers take both so that writers can move to zstd once every reader does, blocklyd's
 * included. Nothing here writes one.
 *
 * Not for what a player downloads or uploads. The bytes are the runtime port's (`GZIP_MAGIC`,
 * `ZSTD_MAGIC` in `app/ports/runtime.ts`), copied here since minecraft/ takes only types from it;
 * `archive-unpack.test.ts` holds the copies equal.
 */

/** gzip's magic bytes (RFC 1952), as `od -An -tx1` prints them. */
export const GZIP_MAGIC_HEX = '1f8b'
/** A zstd frame's magic number, 0xFD2FB528 little-endian (RFC 8878, 3.1.1), as `od` prints it. */
export const ZSTD_MAGIC_HEX = '28b52ffd'

/**
 * A shell function: `inflater <hex>` prints the command that inflates an archive whose first bytes
 * those are, failing for neither. `$(inflater "$h")` is left unquoted where it runs, so its words
 * split into the command.
 */
export const ARCHIVE_INFLATER = [
  'inflater() {',
  '  case "$1" in',
  `    ${ZSTD_MAGIC_HEX}*) echo "zstd -dcq" ;;`,
  `    ${GZIP_MAGIC_HEX}*) echo "gzip -dc" ;;`,
  '    *) echo "the archive is neither gzip nor zstd" >&2; return 1 ;;',
  '  esac',
  '}',
].join('\n')
