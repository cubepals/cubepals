// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Proves that an existing test file only gained cases, so it can be judged as an addition rather
 * than as an edit of every case it holds. Both revisions are parsed as data, never run.
 *
 * Holds only when: every base case is in the head with identical source; the new statements are
 * plain `test(...)` or `it(...)` calls placed after every existing case, so they run after them;
 * removing them leaves the base file's tokens and comments, except for names added to an import
 * the base already has, which nothing else uses; and the base has no concurrent tests and no
 * after-hook that asserts, so a new case cannot run beside an old one or settle an old assertion.
 *
 * Not for: judging the new cases themselves. They still run and count toward coverage, and like a
 * new test file they are not certified as strong.
 */
import { parse } from './toolchain.mjs'

const CASE = new Set(['test', 'it'])

function ast(text, path) {
  return parse(text, {
    sourceType: 'unambiguous',
    sourceFilename: path,
    tokens: true,
    plugins: [
      ...(/\.[cm]?tsx?$/.test(path) ? ['typescript'] : []),
      ...(/\.[jt]sx$/.test(path) ? ['jsx'] : []),
      'importAttributes',
    ],
  })
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node.type === 'string') visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (!['loc', 'comments', 'tokens', 'leadingComments', 'trailingComments', 'innerComments'].includes(key))
      walk(value, visit)
  }
}

/** Statements that register one plain case: `test(...)` or `it(...)`, called directly. */
function cases(tree) {
  const found = []
  walk(tree.program, (node) => {
    if (
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'CallExpression' &&
      node.expression.callee.type === 'Identifier' &&
      CASE.has(node.expression.callee.name)
    )
      found.push(node)
  })
  return found
}

function signature(tree) {
  return JSON.stringify([
    tree.tokens.map((token) => [token.type?.label ?? token.type, token.value ?? null]),
    tree.comments.map((comment) => comment.value),
  ])
}

/** The specifiers an import declaration binds, as `imported as local`. */
const bound = (declaration) =>
  declaration.specifiers.map((item) =>
    item.type === 'ImportSpecifier'
      ? `${item.importKind ?? 'value'} ${item.imported.name ?? item.imported.value} as ${item.local.name}`
      : `${item.type} ${item.local.name}`,
  )

/** Whether the base's hooks or tests could let a new case run beside, or settle, an old one. */
function unsafeBase(tree, text) {
  let unsafe = false
  walk(tree.program, (node) => {
    if (node.type === 'Identifier' && node.name === 'concurrent') unsafe = true
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      ['afterAll', 'afterEach'].includes(node.callee.name) &&
      /\b(?:expect|assert)\b/.test(text.slice(node.start, node.end))
    )
      unsafe = true
  })
  return unsafe
}

/**
 * Returns `{ appended: true, added }` with the number of new cases, or `{ appended: false, reason }`.
 * Anything it cannot prove is refused; the caller then keeps an edited file's full obligations.
 */
export function appendedCases(path, baseText, headText) {
  const refuse = (reason) => ({ appended: false, reason })
  let base
  let head
  try {
    base = ast(baseText, path)
    head = ast(headText, path)
  } catch (error) {
    return refuse(`cannot parse: ${error.message}`)
  }
  if (unsafeBase(base, baseText)) return refuse('concurrent cases or an asserting after-hook')
  const remaining = new Map()
  for (const node of cases(base)) {
    const text = baseText.slice(node.start, node.end)
    remaining.set(text, (remaining.get(text) ?? 0) + 1)
  }
  const added = []
  let lastExisting = -1
  for (const node of cases(head)) {
    const text = headText.slice(node.start, node.end)
    if ((remaining.get(text) ?? 0) > 0) {
      remaining.set(text, remaining.get(text) - 1)
      lastExisting = Math.max(lastExisting, node.end)
    } else added.push(node)
  }
  if (!added.length) return refuse('no case was added')
  if ([...remaining.values()].some((count) => count > 0))
    return refuse('an existing case changed or was removed')
  if (added.some((node) => node.start < lastExisting)) return refuse('a new case runs before an existing one')

  // Cut the new cases out, and put back the base's form of any import that only gained names.
  const edits = added.map((node) => ({ start: node.start, end: node.end, text: '' }))
  const baseImports = base.program.body.filter((node) => node.type === 'ImportDeclaration')
  const addedNames = []
  for (const node of head.program.body.filter((item) => item.type === 'ImportDeclaration')) {
    const match = baseImports.find(
      (item) =>
        item.source.value === node.source.value &&
        (item.importKind ?? 'value') === (node.importKind ?? 'value'),
    )
    if (!match) continue
    const before = bound(match)
    const after = bound(node)
    if (before.join() === after.join()) continue
    if (!before.every((item) => after.includes(item))) return refuse('an existing import changed')
    for (const item of after.filter((entry) => !before.includes(entry))) {
      const [kind, imported, , local] = item.split(' ')
      if (!['value', 'type'].includes(kind) || imported !== local)
        return refuse('an import gained a default, namespace or renamed binding')
      addedNames.push(local)
    }
    edits.push({ start: node.start, end: node.end, text: baseText.slice(match.start, match.end) })
  }
  let stripped = headText
  for (const edit of edits.sort((a, b) => b.start - a.start))
    stripped = stripped.slice(0, edit.start) + edit.text + stripped.slice(edit.end)
  let rest
  try {
    rest = ast(stripped, path)
  } catch (error) {
    return refuse(`cannot parse without the new cases: ${error.message}`)
  }
  if (signature(rest) !== signature(base)) return refuse('more than new cases changed')
  // A name an import gained must serve only the new cases, never code the base already had.
  const used = new Set()
  walk(rest.program, (node) => {
    if (node.type === 'Identifier') used.add(node.name)
  })
  const reused = addedNames.find((name) => used.has(name))
  if (reused) return refuse(`existing code uses the newly imported ${reused}`)
  return { appended: true, added: added.length }
}
