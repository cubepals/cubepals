// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The exact releases of the performance mods Cubepals adds to a Fabric server (`mods.ts`'s
 * `PERFORMANCE`), for each Minecraft release it offers Fabric on: one release of each mod, by its
 * Modrinth version and the SHA-512 of its file, as Modrinth's API lists them
 * (`/v2/project/<project>/version`).
 *
 * Only these are ever pinned (`app/compat/service.ts`), and a start places a jar only where its
 * bytes hash to the one written here (`carried.ts`). Nothing newer reaches a server because its
 * project published it: a newer release arrives by a change to this file, in a pull request. A
 * release of Minecraft not listed here starts without them.
 *
 * Not for which mods they are, or which server gets them (`app/compat/performance.ts`).
 */
import { FERRITECORE, LITHIUM } from './mods.ts'

/** One release of one mod: its Modrinth project and version, and its file's SHA-512. */
export interface PerformancePin {
  readonly projectId: string
  readonly versionId: string
  readonly sha512: string
}

/** The releases to pin, by Minecraft release. */
export type PerformancePins = Readonly<Record<string, readonly PerformancePin[]>>

export const PERFORMANCE_PINS: PerformancePins = {
  '26.3': [
    // mc26.3-0.26.3-fabric
    {
      projectId: LITHIUM,
      versionId: 'fWv5bnZk',
      sha512:
        '2ca92fb530135d2baddf0ba4cc4f93976234876a38c4aa02b487b2552400f005afcfbeebf5373fb4396fe2020537a42d7597b8da5a52b904355ef51d5fef07ad',
    },
    // 9.0.0-fabric
    {
      projectId: FERRITECORE,
      versionId: 'd5ddUdiB',
      sha512:
        'd81fa97e11784c19d42f89c2f433831d007603dd7193cee45fa177e4a6a9c52b384b198586e04a0f7f63cd996fed713322578bde9a8db57e1188854ae5cbe584',
    },
  ],
  '26.2': [
    // mc26.2-0.25.3-fabric
    {
      projectId: LITHIUM,
      versionId: 'f7vZ0VWU',
      sha512:
        '148b638f3c6229fbaf487120a2344a0af5e411a5aa6533d5db9d75da0a8c0d8304f63eb4cca13f4d03b2c9b4c23d559dd74c1d832422ef8a3087bd005e62a8bd',
    },
    // 9.0.0-fabric
    {
      projectId: FERRITECORE,
      versionId: 'd5ddUdiB',
      sha512:
        'd81fa97e11784c19d42f89c2f433831d007603dd7193cee45fa177e4a6a9c52b384b198586e04a0f7f63cd996fed713322578bde9a8db57e1188854ae5cbe584',
    },
  ],
  '26.1.2': [
    // mc26.1.2-0.24.7-fabric
    {
      projectId: LITHIUM,
      versionId: 'Oqq8TOAV',
      sha512:
        '37240bdbf93c19fdc6aa632d89223639f0ef9d923ee1793b33d624946b0482cc972834049ed07d71db3494e16c9de68e755937aac7c4ac5d7291bd38c1425899',
    },
    // 9.0.0-fabric
    {
      projectId: FERRITECORE,
      versionId: 'd5ddUdiB',
      sha512:
        'd81fa97e11784c19d42f89c2f433831d007603dd7193cee45fa177e4a6a9c52b384b198586e04a0f7f63cd996fed713322578bde9a8db57e1188854ae5cbe584',
    },
  ],
  '1.21.11': [
    // mc1.21.11-0.21.4-fabric
    {
      projectId: LITHIUM,
      versionId: 'Ow7wA0kG',
      sha512:
        'f14a5c3d2fad786347ca25083f902139694f618b7c103947f2fd067a7c5ee88a63e1ef8926f7d693ea79ed7d00f57317bae77ef9c2d630bf5ed01ac97a752b94',
    },
    // 8.2.0-fabric
    {
      projectId: FERRITECORE,
      versionId: 'Ii0gP3D8',
      sha512:
        '3210926a82eb32efd9bcebabe2f6c053daf5c4337eebc6d5bacba96d283510afbde646e7e195751de795ec70a2ea44fef77cb54bf22c8e57bb832d6217418869',
    },
  ],
  '1.21.10': [
    // mc1.21.10-0.20.1-fabric
    {
      projectId: LITHIUM,
      versionId: 'NsswKiwi',
      sha512:
        '79b2892d123f3bb12649927dd8fccc25c955ff38a19f3aba7cd0180c4cf5506c2a76d49418b13050f90bba7bb59f3623af06e8a275e2ae8c63808084043902bb',
    },
    // 8.1.0-fabric
    {
      projectId: FERRITECORE,
      versionId: 'bPLllEgi',
      sha512:
        '0596c83d69867380260e20500e5ab184415a1178317464c2b7c8c68a87db435fbe7a80b22b4f50b56558d6506f7dbb35ad7bda16f46eab5b79d38f0d726f08f5',
    },
  ],
  '1.21.8': [
    // mc1.21.8-0.18.1-fabric
    {
      projectId: LITHIUM,
      versionId: 'qxIL7Kb8',
      sha512:
        'ef3e0820c7c831c352cbd5afa4a1f4ff73db0fa3c4e4428ba35ad2faeb8e7bce8ae4805a04934be82099012444a70c0a2cf2049f2af95fe688ca84d94d1c4672',
    },
    // 8.0.4-fabric
    {
      projectId: FERRITECORE,
      versionId: 'LdlksamY',
      sha512:
        '8be6c49aa5900f434c082f505a48cf6bafc70bb43e9b9d4e0e42524605d2d22f968bc3a0c0048190a5296fd3cc696d8c3a7329dc8a022792f920e83ece47e5b6',
    },
  ],
  '1.21.1': [
    // mc1.21.1-0.15.4-fabric
    {
      projectId: LITHIUM,
      versionId: 'N08Z8wog',
      sha512:
        '182064b00e6315e2255b857eaab8eb759e6b042ebd4cc8b855ff0d93f875a5a7188fac49f878d7b29d4ef7e6b6341190ad7f6f6f39f4a6d2c62003468b08e4c6',
    },
    // 7.0.3-fabric
    {
      projectId: FERRITECORE,
      versionId: 'sOzRw3CG',
      sha512:
        '3ad31620fac4ff44327dc7dedbe162b2d978f3f246dc16255a6e400ce9592a0d326fe36a626f3c1bf30a11f813093cbb4dcc107af039cff724d0cdf648541fdf',
    },
  ],
  '1.20.1': [
    // mc1.20.1-0.11.4-fabric
    {
      projectId: LITHIUM,
      versionId: 'iEcXOkz4',
      sha512:
        '31938b7e849609892ffa1710e41f2e163d11876f824452540658c4b53cd13c666dbdad8d200989461932bd9952814c5943e64252530c72bdd5d8641775151500',
    },
    // 6.0.1
    {
      projectId: FERRITECORE,
      versionId: 'unerR5MN',
      sha512:
        '9b7dc686bfa7937815d88c7bbc6908857cd6646b05e7a96ddbdcada328a385bd4ba056532cd1d7df9d2d7f4265fd48bd49ff683f217f6d4e817177b87f6bc457',
    },
  ],
}
