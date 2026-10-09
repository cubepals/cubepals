'use client'

import { useStage } from './stage'

/**
 * What the chunk says back, in the game's voice, when someone does something to it that needs a
 * word: a block that is kept, bedrock, what was dug being put back. One line at a time, at the
 * lower left where the game's own chat is, read out politely for anyone who can't see it.
 */
export function Chat() {
  const said = useStage((stage) => stage.said)
  return (
    <div className="bl-chat bl-game" aria-live="polite">
      {said && <span key={said.id}>{said.text}</span>}
    </div>
  )
}
