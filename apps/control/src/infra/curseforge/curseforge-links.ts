import type { CurseForge, CurseForgeLink } from '../../app/ports/curseforge.ts'

/**
 * CurseForge's addresses, read and never fetched: `/minecraft/modpacks/<slug>` and its
 * `/files/<id>` and `/download/<id>` pages, the same under `/mc-mods/`, on www., legacy. or bare
 * curseforge.com. There is no permission to download from CurseForge, so `files` is null.
 */
export class CurseForgeLinks implements CurseForge {
  readonly files = null

  linkOf(url: string): CurseForgeLink | null {
    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      return null
    }
    const host = parsed.hostname.toLowerCase()
    if (host !== 'curseforge.com' && !host.endsWith('.curseforge.com')) return null
    const [game, section, slug] = parsed.pathname.split('/').filter(Boolean)
    if (game !== 'minecraft' || !slug)
      return { kind: 'other', name: 'this project', filesPage: 'https://www.curseforge.com/minecraft' }
    const kind = section === 'modpacks' ? 'modpack' : section === 'mc-mods' ? 'mod' : 'other'
    return {
      kind,
      name: slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      filesPage: `https://www.curseforge.com/minecraft/${section}/${slug}/files`,
    }
  }
}
