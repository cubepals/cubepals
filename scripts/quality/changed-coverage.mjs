// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Restricts existing-file coverage to the executable locations selected by a verified Git diff. */
export function changedCounters(file, ranges) {
  if (ranges === null) return file
  if (
    !Array.isArray(ranges) ||
    ranges.some(
      ({ start, end }) =>
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start,
    )
  )
    throw new Error('Changed coverage requires verified inclusive line ranges')
  const includes = (line) => ranges.some(({ start, end }) => start <= line && line <= end)
  const overlaps = (loc) =>
    loc && ranges.some(({ start, end }) => loc.start.line <= end && start <= loc.end.line)
  const statements = new Set()
  for (const [id, loc] of Object.entries(file.statementMap)) if (includes(loc.start.line)) statements.add(id)
  // A multiline expression can start before the changed line. Select its smallest containing
  // statement, rather than crediting an enclosing function declaration loaded with the module.
  for (const { start, end } of ranges)
    for (let line = start; line <= end; line++) {
      const containing = Object.entries(file.statementMap).filter(
        ([, loc]) => loc.start.line <= line && line <= loc.end.line,
      )
      const size = ([, loc]) => loc.end.line - loc.start.line
      const smallest = Math.min(...containing.map(size))
      for (const entry of containing) if (size(entry) === smallest) statements.add(entry[0])
    }
  const pick = (object, ids) => Object.fromEntries([...ids].map((id) => [id, object[id]]))
  const functions = new Set(
    Object.entries(file.fnMap)
      .filter(([, fn]) => overlaps(fn.loc) || overlaps(fn.decl))
      .map(([id]) => id),
  )
  const branchMap = {}
  const branches = {}
  for (const [id, branch] of Object.entries(file.branchMap)) {
    const decision = includes(branch.loc.start.line)
    const arms = branch.locations
      .map((loc, index) => ({ loc, index }))
      .filter(({ loc }) => decision || overlaps(loc))
    if (!arms.length) continue
    branchMap[id] = { ...branch, locations: arms.map(({ loc }) => loc) }
    branches[id] = arms.map(({ index }) => file.b[id][index])
  }
  return {
    ...file,
    statementMap: pick(file.statementMap, statements),
    s: pick(file.s, statements),
    fnMap: pick(file.fnMap, functions),
    f: pick(file.f, functions),
    branchMap,
    b: branches,
  }
}
