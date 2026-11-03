// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Selects tests from both revisions; uncertainty widens the relevant runtime instead of dropping evidence. */
export function closure(graph, starts) {
  const seen = new Set()
  const pending = [...starts]
  while (pending.length) {
    const path = pending.pop()
    if (seen.has(path)) continue
    seen.add(path)
    pending.push(...(graph.get(path) ?? []))
  }
  return seen
}

function consumers(graph, paths) {
  const reverse = new Map()
  for (const [file, dependencies] of graph)
    for (const dependency of dependencies) {
      if (!reverse.has(dependency)) reverse.set(dependency, new Set())
      reverse.get(dependency).add(file)
    }
  return closure(reverse, paths)
}

export function affectedSelection(views, changed, { website = false, full = false } = {}) {
  if (
    !Array.isArray(views) ||
    views.length !== 2 ||
    views.some(
      (view) =>
        !(view.graph instanceof Map) || !(view.ambiguous instanceof Set) || !Array.isArray(view.tests),
    )
  )
    throw new Error('Selection requires both complete dependency views')
  const reasons = []
  const selected = new Set(changed)
  const relevantUnknown = views.flatMap((view) =>
    [...view.ambiguous].filter((path) => !website || path.startsWith('apps/web/')),
  )
  if (relevantUnknown.length) {
    reasons.push('Uncertain runtime dependencies require all tests in that runtime')
    full = true
  }
  for (const view of views) {
    for (const path of consumers(view.graph, changed)) selected.add(path)
    if (full) for (const path of view.tests) if (!website || path.startsWith('apps/web/')) selected.add(path)
  }
  // An entrypoint or data input with no direct oracle still needs the runtime's tests and build.
  if (!views.some((view) => view.tests.some((path) => selected.has(path)))) {
    reasons.push('No direct test mapping; use the complete runtime test inventory')
    for (const view of views)
      for (const path of view.tests) if (!website || path.startsWith('apps/web/')) selected.add(path)
  }
  if (views.some((view) => !view.tests.some((path) => selected.has(path)))) {
    reasons.push('One side has no mapped oracle; compare the complete runtime inventory')
    for (const view of views)
      for (const path of view.tests) if (!website || path.startsWith('apps/web/')) selected.add(path)
  }
  const tests = views.map((view) => view.tests.filter((path) => selected.has(path)).sort())
  const measured = views.map((view, index) => [...closure(view.graph, tests[index])].sort())
  return { tests, measured, reasons, fallback: full }
}
