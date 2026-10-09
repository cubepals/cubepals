/**
 * The pictures in a player's inventory: for each item, how the browser draws it from its release's
 * own textures, and those textures. The art is the release's, read from its client jar through
 * `ClientAssets`; how a model becomes a picture is `minecraft/item-models.ts`'s. Only releases
 * Blockly offers are asked for, so nobody can make it fetch whatever Mojang lists. Where the art
 * can't be had, every item comes back without a picture and the page writes its name.
 */
import type { ItemIconView } from '@blockly/contracts'
import { iconOf } from '../../minecraft/item-models.ts'
import { offeredVersions } from '../../minecraft/versions.ts'
import type { ClientAssets, ClientFiles } from '../ports/minecraft.ts'

export class ItemIcons {
  readonly #assets: ClientAssets
  readonly #icons = new Map<string, ItemIconView>()

  constructor(deps: { assets: ClientAssets }) {
    this.#assets = deps.assets
  }

  /** Each item's picture, by id; null for one with none. */
  async icons(gameVersion: string, ids: readonly string[]): Promise<Record<string, ItemIconView>> {
    const files = await this.#files(gameVersion)
    const icons: Record<string, ItemIconView> = {}
    for (const id of new Set(ids)) {
      const key = `${gameVersion} ${id}`
      let icon = this.#icons.get(key)
      if (icon === undefined && files !== null) {
        icon = iconOf(id, {
          json: (path) => parseJson(files.read(path)),
          hasTexture: (texture) => files.read(`textures/${texture}.png`) !== null,
        })
        this.#icons.set(key, icon)
      }
      icons[id] = icon ?? null
    }
    return icons
  }

  /** One texture's PNG, by the name an icon gives it (`block/oak_log`). */
  async texture(gameVersion: string, texture: string): Promise<Uint8Array | null> {
    if (!/^(block|item)\/[a-z0-9_/]+$/.test(texture)) return null
    return (await this.#files(gameVersion))?.read(`textures/${texture}.png`) ?? null
  }

  async #files(gameVersion: string): Promise<ClientFiles | null> {
    if (!offeredVersions().some((v) => v.id === gameVersion)) return null
    return this.#assets.open(gameVersion).catch((error: unknown) => {
      console.warn('item icons', gameVersion, error instanceof Error ? error.message : error)
      return null
    })
  }
}

function parseJson(bytes: Uint8Array | null): unknown {
  if (bytes === null) return null
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}
