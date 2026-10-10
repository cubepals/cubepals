// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a person tells Cubepals' builder: a line of feedback from the sidebar, and the answer to
 * "How's it going?" asked after a good moment. The control plane sends both to PostHog.
 */
import { z } from 'zod'

/** The page a person was on and the build they were running, which the app attaches for them. */
const Where = {
  page: z.string().trim().max(300),
  version: z.string().trim().max(64),
}

export const FeedbackInput = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Write something first.')
    .max(4000, 'That’s a lot. Keep it under 4,000 characters.'),
  ...Where,
})

/** The moments a question can follow, as the funnel names them. */
export const MOMENTS = ['moment_first_friend_joined', 'moment_first_wake', 'moment_first_week'] as const
export type MomentKey = (typeof MOMENTS)[number]

export const MomentAskInput = z.object({
  /** The page is one where someone is making a server or paying: no question there. */
  busy: z.boolean(),
})

export const MomentRef = z.object({ moment: z.enum(MOMENTS) })

export const MomentAnswerInput = z.object({
  moment: z.enum(MOMENTS),
  rating: z.enum(['Good', 'Not great']),
  text: z.string().trim().max(2000).optional(),
  ...Where,
})

/** A question waiting to be asked, with what it noticed, so it reads as noticed. */
export interface MomentAskView {
  moment: MomentKey
  /** When the moment happened, ISO. */
  at: string
  serverName: string
  /** The friend who joined, for that moment. */
  player: string | null
}

/** Whether PostHog took it: false when it couldn't be reached, or this deployment sends nothing. */
export interface InsightSentView {
  sent: boolean
}
