/**
 * The product analytics service (PostHog): funnel events, feedback and errors, each about an
 * account by its id and never by its email. A deployment without it has none: the composition
 * root passes null, and nothing is sent.
 */

export interface InsightEvent {
  /** The account's id, or the deployment's own for what no account did. */
  distinctId: string
  event: string
  properties: Record<string, unknown>
  /** When it happened, for an event sent after the fact; now when left out. */
  at?: Date
}

export interface Insight {
  /** Sent now: true once the service took it, false when it couldn't be reached. Never throws. */
  send(event: InsightEvent): Promise<boolean>
  /** Sent in the background; nothing waits for it, and a failure is only logged. */
  capture(event: InsightEvent): void
  /** An error, with where it happened (a route, a request id); never what a request carried. */
  exception(error: unknown, context: { distinctId?: string; properties: Record<string, string> }): void
  /** Sends what is still queued, before the process exits. */
  shutdown(): Promise<void>
}
