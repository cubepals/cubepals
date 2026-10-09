import { type BuiltLoader, type LoaderBuilds, LoaderBuildsUnavailable } from '../../app/ports/loaders.ts'

/** Each server type's current build, as a test sets it; the builds the live lists had on 2026-09-19. */
export class FakeLoaderBuilds implements LoaderBuilds {
  readonly builds = new Map<BuiltLoader, string | null>([
    ['paper', '60'],
    ['fabric', '0.19.5'],
    ['quilt', '0.30.1'],
    ['neoforge', '21.8.54'],
    ['forge', '58.1.0'],
  ])
  /** Server types whose list can't be read, as when their service is down. */
  readonly down = new Set<BuiltLoader>()
  /** What was asked, in order. */
  readonly asked: string[] = []

  async current(loader: BuiltLoader, gameVersion: string): Promise<string | null> {
    this.asked.push(`${loader} ${gameVersion}`)
    if (this.down.has(loader)) throw new LoaderBuildsUnavailable(loader, 'answered 503')
    return this.builds.get(loader) ?? null
  }
}
