/**
 * Which build of its server software a revision pins (§4), so it boots the same way every time:
 * a server type's current build, and the Paper build plain Minecraft runs on. Reading the build
 * lists is `LoaderBuilds`'; choosing the server type is the caller's.
 */
import type { Loader, RevisionDraft } from '../../domain/revision/revision.ts'
import { LOADER_LABELS, supports } from '../../minecraft/versions.ts'
import { AppError } from '../errors.ts'
import { type LoaderBuilds, LoaderBuildsUnavailable } from '../ports/loaders.ts'

/**
 * The loader build a revision for a newly chosen game version or server type pins (§4): vanilla
 * has none; the others take their server type's current build, so the revision boots the same
 * way every time. A version the server type has no stable build for can't be chosen, and one
 * whose build list can't be read waits until it can.
 */
export async function loaderPin(
  builds: LoaderBuilds,
  loader: Loader,
  gameVersion: string,
): Promise<string | null> {
  if (loader === 'vanilla') return null
  let pin: string | null
  try {
    pin = await builds.current(loader, gameVersion)
  } catch (error) {
    if (!(error instanceof LoaderBuildsUnavailable)) throw error
    throw new AppError(
      'catalog_unavailable',
      `${LOADER_LABELS[loader]}'s list of builds can't be reached right now. Try again in a minute.`,
    )
  }
  if (pin === null)
    throw new AppError(
      'invalid_choice',
      `${LOADER_LABELS[loader]} has no stable build for Minecraft ${gameVersion} yet.`,
    )
  return pin
}

/**
 * A revision drafted from one made before builds were pinned takes the current build now: the
 * server would have booted the newest one anyway. If the build list can't be read, the draft stays
 * as it was, and boots the newest, as before.
 */
export async function pinUnpinned(builds: LoaderBuilds, draft: RevisionDraft): Promise<void> {
  if (draft.loaderVersion !== null || draft.loader === 'vanilla') return
  draft.loaderVersion = await builds.current(draft.loader, draft.gameVersion).catch(() => null)
}

/**
 * The Paper build plain Minecraft runs on (`runsOnPaper`): Paper's current stable build where
 * Cubepals offers Paper for the release, and null, Mojang's own server, where it doesn't. A list
 * that can't be read leaves a new server on Mojang's own (`plain`), as every server was before
 * Paper became the default, and a change waits until it can be read (`refuse`), as any change of
 * server type does.
 */
export async function paperPin(
  builds: LoaderBuilds,
  gameVersion: string,
  unreadable: 'plain' | 'refuse',
): Promise<string | null> {
  if (!supports(gameVersion, 'paper')) return null
  try {
    return await builds.current('paper', gameVersion)
  } catch (error) {
    if (!(error instanceof LoaderBuildsUnavailable) || unreadable === 'plain') return null
    throw new AppError(
      'catalog_unavailable',
      "Paper's list of builds can't be reached right now. Try again in a minute.",
    )
  }
}
