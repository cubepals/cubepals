// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Offensive server names and addresses, which nobody gives a server and the directory doesn't
 * show. The control plane refuses them and the web app says so as they are typed, both from here.
 *
 * obscenity (MIT, kept on npm) finds them: its English list of slurs and sexual words, read
 * through leetspeak (`sh1t`), look-alike letters (`fück`), letters repeated (`fuuuck`) and
 * symbols between them. It does not read a word spelled out a letter at a time, so those are
 * joined up first (`f u c k`, `f-u-c-k`). Its list has no hate words, so the two that are never
 * anything else are added, and the places and surnames its words sit inside are let through.
 */
import { DataSet, englishDataset, englishRecommendedTransformers, pattern, RegExpMatcher } from 'obscenity'

/** What a player is told, without the word said back. */
export const PICK_ANOTHER_NAME = 'Pick another name.'

const dataset = new DataSet<{ originalWord: string }>()
  .addAll(englishDataset)
  .addPhrase((phrase) => phrase.setMetadata({ originalWord: 'nazi' }).addPattern(pattern`|nazi`))
  .addPhrase((phrase) => phrase.setMetadata({ originalWord: 'hitler' }).addPattern(pattern`hitler`))

const built = dataset.build()
const matcher = new RegExpMatcher({
  ...built,
  whitelistedTerms: [...(built.whitelistedTerms ?? []), 'penistone', 'dickinson', 'tit for tat'],
  ...englishRecommendedTransformers,
})

/** Three or more single letters or digits in a row, each set apart by a space or a mark. */
const SPELLED_OUT = /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][\s._*-]+){2,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu

/** Whether a name, or the address it would become, is a slur, hate or a sexual word, disguised or not. */
export const offensive = (text: string): boolean =>
  matcher.hasMatch(text.replace(SPELLED_OUT, (run) => run.replace(/[\s._*-]+/g, '')))
