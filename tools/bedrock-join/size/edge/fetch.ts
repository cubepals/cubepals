// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Saves a URL to a file, for a sizing edge's start (boot.sh), whose image has no curl: `bun fetch.ts <url> <file>`. */
const [url = '', file = ''] = process.argv.slice(2)
const response = await fetch(url)
if (!response.ok) throw new Error(`${url}: ${response.status}`)
await Bun.write(file, response)
