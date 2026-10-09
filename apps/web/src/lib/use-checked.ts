'use client'

import { useState } from 'react'
import type { Rule } from './rules'

/**
 * A field that says what is wrong with it, once the person has had their say (§15.6).
 *
 * Nothing appears while somebody is still typing their first attempt: the message arrives when
 * they leave the field or press the button, and goes the moment they start fixing it. That is
 * the difference between a form that helps and one that nags.
 */
export function useChecked(rule: Rule, value: string) {
  const [shown, setShown] = useState(false)
  const problem = rule(value)
  return {
    /** What to show under the field: the problem, once it is worth saying. */
    error: shown ? problem : null,
    /** Spread onto the field: it starts checking when they leave it. */
    field: {
      onBlur: () => setShown(true),
      ...(problem === null ? {} : { onInput: () => setShown(false) }),
    },
    /** Whether the value is good enough to send. */
    ok: problem === null,
    /** Called before sending: shows the problem if there is one, and says whether to go on. */
    check: () => {
      setShown(true)
      return problem === null
    },
  }
}
