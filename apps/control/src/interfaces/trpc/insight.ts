// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import { FeedbackInput, MomentAnswerInput, MomentAskInput, MomentRef } from '@blockly/contracts'
import { authedProcedure, router } from './trpc.ts'

/** What a person tells Cubepals' builder: feedback, and the answer to a good moment's question. */
export const insight = router({
  feedback: authedProcedure
    .input(FeedbackInput)
    .mutation(({ ctx, input }) => ctx.services.insight.feedback(ctx.actor, input)),
  /** The question to ask now, if any; asking marks it shown. */
  moment: authedProcedure
    .input(MomentAskInput)
    .mutation(({ ctx, input }) => ctx.services.insight.ask(ctx.actor, input.busy)),
  answerMoment: authedProcedure
    .input(MomentAnswerInput)
    .mutation(({ ctx, input }) => ctx.services.insight.answer(ctx.actor, input)),
  dismissMoment: authedProcedure
    .input(MomentRef)
    .mutation(({ ctx, input }) => ctx.services.insight.dismiss(ctx.actor, input.moment)),
})
