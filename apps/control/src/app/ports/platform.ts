import type { RuntimeHandle } from './runtime.ts'

/** A deployment's addressing. The only address knowledge the application layer has. */
export interface PlayAddress {
  hostname: string
  port: number
}

export interface PlayAddressing {
  /** What people are shown and copy. */
  primary(slug: string): PlayAddress
  /** Every address that must route to this server: the primary plus migration aliases. */
  all(slug: string): readonly PlayAddress[]
  /** The inverse, for edge reports. Normalizes case, trailing dot and port; null if not ours. */
  slugFor(hostname: string): string | null
  /** The play domains: the primary first, then the migration aliases (§11). */
  domains(): readonly { domain: string; alias: boolean }[]
  /** Which play domain a hostname is under, so an alias's traffic can be watched; null if none. */
  domainFor(hostname: string): string | null
}

/** The product's region catalog: keys and the names people see. */
export interface RegionCatalog {
  list(): readonly { key: string; label: string }[]
  label(key: string): string | null
  readonly defaultKey: string
}

/** A raw line of workload output. What it means is Minecraft knowledge, decided elsewhere. */
export interface LogLine {
  at: Date
  text: string
}

/**
 * A workload's output, found by the handle its runtime issued: every runtime brings its own, and
 * main.node.ts pairs them. A tail follows one workload through its restarts (§15.5).
 */
export interface LogSource {
  recent(handle: RuntimeHandle, limit: number): Promise<LogLine[]>
  tail(handle: RuntimeHandle, signal: AbortSignal): AsyncIterable<LogLine>
}

export interface Mailer {
  /** One email: with `html`, both parts, and the text is what a mail app without HTML shows. */
  send(message: { to: string; subject: string; text: string; html?: string }): Promise<void>
}
