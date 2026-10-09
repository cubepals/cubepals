import type { Insight, InsightEvent } from '../app/ports/insight.ts'

/** Everything the application would send to PostHog, in order, instead of PostHog. */
export class RecordedInsight implements Insight {
  readonly events: InsightEvent[] = []
  readonly exceptions: Array<{ error: unknown; distinctId?: string; properties: Record<string, string> }> = []
  /** Set false to play PostHog being away: `send` answers false and keeps nothing. */
  reachable = true

  async send(event: InsightEvent): Promise<boolean> {
    if (!this.reachable) return false
    this.events.push(event)
    return true
  }

  capture(event: InsightEvent): void {
    if (this.reachable) this.events.push(event)
  }

  exception(error: unknown, context: { distinctId?: string; properties: Record<string, string> }): void {
    this.exceptions.push({ error, ...context })
  }

  async shutdown(): Promise<void> {}

  /** What was sent about one account, by event name. */
  named(event: string, distinctId?: string): InsightEvent[] {
    return this.events.filter(
      (e) => e.event === event && (distinctId === undefined || e.distinctId === distinctId),
    )
  }
}
