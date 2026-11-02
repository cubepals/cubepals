// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/** Selected-loader evidence for dependencies published as one union for a universal jar. */
import type { CatalogProject, CatalogVersion } from './catalog.ts'
import type { FabricMod, JarNeeds, LoaderMod } from './jar-holds.ts'

export interface DependencyDecision {
  kind: 'foreign_loader_dependency'
  from: string
  projectId: string
  loader: string
  artifactSha512: string
}

export interface LoaderTarget {
  loader?: string
  loaders: readonly string[]
}

export function nativeFor(
  target: LoaderTarget,
  needs: JarNeeds | null | undefined,
): (FabricMod & { environment?: LoaderMod['environment'] }) | null | undefined {
  const loader = target.loader ?? target.loaders[0]
  if (loader === undefined) return undefined
  const declared = declaredFor(loader, needs)
  return declared ?? (target.loaders.includes('fabric') ? needs?.mod : undefined)
}

export function foreignDependency(
  target: LoaderTarget,
  parent: CatalogVersion,
  needs: JarNeeds | null | undefined,
  dependency: Pick<CatalogProject, 'loaders'> | null | undefined,
): boolean {
  const loader = target.loader ?? target.loaders[0]
  if (loader === undefined || dependency?.loaders === undefined || dependency.loaders.length === 0)
    return false
  const declaration = declaredFor(loader, needs)
  if (declaration?.complete !== true || explicitSide(declaration) === 'client') return false
  // Missing evidence never drops a dependency; a single-loader listing has no union to disambiguate.
  if (!parent.loaders.some((listed) => !target.loaders.includes(listed))) return false
  return !dependency.loaders.some((listed) => target.loaders.includes(listed))
}

function declaredFor(loader: string, needs: JarNeeds | null | undefined): LoaderMod | undefined {
  return needs?.native?.[loader] ?? (loader === 'quilt' ? needs?.native?.fabric : undefined)
}

/** An explicit loader side overrides catalog evidence; both or absent leaves that evidence intact. */
export function explicitSide(
  declaration: { environment?: string } | null | undefined,
): 'client' | 'server' | null {
  const environment = declaration?.environment
  return environment === 'client' || environment === 'server' ? environment : null
}
