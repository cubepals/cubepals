/**
 * PostHog, through its own Node SDK, in its EU cloud. Every event, errors included, says which
 * environment sent it (`production`, `staging` or `development`): the project's charts count
 * production's alone. The SDK reports a failed send as an `error` event rather than throwing;
 * `send` listens for one while its request is out.
 */
import { PostHog, type PostHogOptions } from 'posthog-node'
import type { Insight, InsightEvent } from '../../app/ports/insight.ts'

export class PostHogInsight implements Insight {
  readonly #client: PostHog
  readonly #environment: string
  #failures = 0

  constructor(options: {
    token: string
    host: string
    environment: string
    /** What the SDK sends its requests with: a test's stand-in, or the platform's own. */
    fetch?: PostHogOptions['fetch']
  }) {
    this.#client = new PostHog(options.token, {
      host: options.host,
      // The control plane's own address is no one's location.
      disableGeoip: true,
      // Someone may be waiting on a send (feedback): one quick retry, then the answer. The worker's
      // events go again on its next pass.
      requestTimeout: 4_000,
      fetchRetryCount: 1,
      fetchRetryDelay: 500,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    this.#environment = options.environment
    this.#client.on('error', (error) => {
      this.#failures++
      console.warn('insight: PostHog refused or could not be reached', String(error))
    })
  }

  async send(event: InsightEvent): Promise<boolean> {
    const before = this.#failures
    try {
      await this.#client.captureImmediate(this.#message(event))
    } catch (error) {
      console.warn('insight: not sent', String(error))
      return false
    }
    return this.#failures === before
  }

  capture(event: InsightEvent): void {
    try {
      this.#client.capture(this.#message(event))
    } catch (error) {
      console.warn('insight: not queued', String(error))
    }
  }

  exception(error: unknown, context: { distinctId?: string; properties: Record<string, string> }): void {
    try {
      this.#client.captureException(error, context.distinctId, {
        ...context.properties,
        environment: this.#environment,
      })
    } catch (failed) {
      console.warn('insight: error not queued', String(failed))
    }
  }

  async shutdown(): Promise<void> {
    await this.#client.shutdown().catch((error) => console.warn('insight: not flushed', String(error)))
  }

  #message(event: InsightEvent) {
    return {
      distinctId: event.distinctId,
      event: event.event,
      properties: { ...event.properties, environment: this.#environment },
      ...(event.at === undefined ? {} : { timestamp: event.at }),
    }
  }
}
