// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { PixelIcon } from './pixel-icon'

/**
 * "Java and Bedrock": the mark a server wears where Bedrock players join it too, with the same
 * address. Shown only where that is so (`letsBedrockIn`, or a public view's `bedrock`), never on
 * a modded server.
 */
export function JavaAndBedrock() {
  return (
    <span className="bk-badge bk-badge--grass" data-editions>
      <PixelIcon name="bridge" size={12} />
      Java and Bedrock
    </span>
  )
}
