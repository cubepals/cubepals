// Enforces the module boundaries in docs/architecture.md §17. Run: bun run check:boundaries
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const CONTROL = join(ROOT, 'apps/control/src')

const LAYERS = ['domain', 'minecraft', 'app', 'infra', 'interfaces', 'config', 'main', 'testing'] as const
type Layer = (typeof LAYERS)[number]

const PURE_PACKAGES = /^$/ // domain and minecraft import no packages at all
const APP_PACKAGES = /^(@blockly\/(db|contracts)(\/.*)?|drizzle-orm(\/.*)?|zod|node:.*)$/

/** A string literal holding a hostname, with or without a scheme (§17). */
const HOSTNAME =
  /['"`](?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:gg|online|com|io|dev|app|net|org|sh|me|cloud))(?=['"`/:])/g
/**
 * Namespaces that look like addresses but are part of a file format: nothing ever connects to
 * them, and a document is invalid without them.
 */
const FORMAT_NAMESPACES = /^www\.w3\.org$/

/** Each provider's hosts, which only its own adapter may name. */
const PROVIDER_HOSTS: Record<string, RegExp> = {
  fly: /(^|\.)(fly\.io|fly\.dev|machines\.dev)$/,
  boat: /(^|\.)boat\.dev$/,
  // A Modrinth pack may download from the hosts its format allows, which the adapter holds packs to.
  modrinth: /(^|\.)(modrinth\.com|github\.com|raw\.githubusercontent\.com|gitlab\.com)$/,
  hangar: /^(hangar|hangarcdn)\.papermc\.io$/,
  curseforge: /(^|\.)(curseforge\.com|forgecdn\.net)$/,
  mojang: /(^|\.)(minecraftservices\.com|mojang\.com|minecraft\.net)$/,
  loaders: /(^|\.)(fabricmc\.net|quiltmc\.org|papermc\.io|minecraftforge\.net|neoforged\.net)$/,
}
/**
 * Minecraft's access files and console commands (§17): minecraft/ alone speaks them. A command is
 * its words with arguments (`ban <name>`), or a multi-word or hyphenated one; a bare `'ban'` is the
 * domain's own tag, which minecraft/ translates.
 */
const MINECRAFT_WORDS =
  /['"`](?:[^'"`]*\b(?:ops|whitelist|banned-players|banned-ips|usercache)\.json\b[^'"`]*|[^'"`]*\bserver\.properties\b[^'"`]*|(?:whitelist (?:add|remove|on|off|list|reload)|(?:op|deop|ban|pardon) \S|ban-ip|pardon-ip|save-all|save-off|save-on|list uuids)[^'"`]*)['"`]/g

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

/** Null for a file outside every layer, which is a violation in itself. */
function layerOf(path: string): Layer | null {
  const rel = relative(CONTROL, path)
  if (rel === 'main.node.ts') return 'main'
  const top = rel.split('/')[0]
  return rel.includes('/') && LAYERS.includes(top as Layer) ? (top as Layer) : null
}

/** Whether `name` is an `as const` list declared in the port, or in the module it re-exports it from. */
function declaresVocabulary(path: string, source: string, name: string): boolean {
  if (new RegExp(`export const ${name} = \\[[^\\]]*\\] as const`).test(source)) return true
  for (const match of source.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g))
    if ((match[1] ?? '').split(',').some((part) => part.trim() === name)) {
      const from = resolve(dirname(path), match[2] ?? '')
      return new RegExp(`export const ${name} = \\[[^\\]]*\\] as const`).test(readFileSync(from, 'utf8'))
    }
  return false
}

/** Source with its comments blanked, so prose about the game isn't read as code. */
const withoutComments = (source: string) => source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')

/**
 * Each runtime adapter's provider id, from `readonly provider = '…'` (or its default, where a test
 * may give a fake another) on a class that implements
 * MinecraftRuntime (§8). The application records one beside every handle and never branches on
 * it: only infra/, config/ and main.node.ts tell runtimes apart.
 */
const RUNTIME_PROVIDERS = files(join(CONTROL, 'infra')).flatMap((file) => {
  const source = readFileSync(file, 'utf8')
  if (!/\bimplements\s+MinecraftRuntime\b/.test(source)) return []
  return [...source.matchAll(/readonly provider(?:: string)? = '([a-z0-9-]+)'/g)].map(
    (match) => match[1] ?? '',
  )
})
/** A string literal that is exactly a runtime's provider id; null when no adapter declares one. */
const PROVIDER_ID =
  RUNTIME_PROVIDERS.length === 0 ? null : new RegExp(`['"\`](?:${RUNTIME_PROVIDERS.join('|')})['"\`]`, 'g')
/** The layers above the runtime port, which express what a workload should be and not where it runs. */
const ABOVE_THE_PORT: ReadonlySet<Layer> = new Set(['domain', 'minecraft', 'app', 'interfaces'])

/** The names an import of `spec` brings in as values (not `type`-marked). */
function valueNames(source: string, spec: string): string[] {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const clause = new RegExp(`import\\s+\\{([^}]*)\\}\\s+from\\s+['"]${escaped}['"]`).exec(source)?.[1] ?? ''
  return clause
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith('type '))
    .map((part) => part.split(/\s+as\s+/)[0] ?? part)
}

function imports(source: string): Array<{ spec: string; typeOnly: boolean }> {
  const found: Array<{ spec: string; typeOnly: boolean }> = []
  const pattern =
    /(?:^|\n)\s*(import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(pattern)) {
    const spec = match[3] ?? match[4]
    if (spec) found.push({ spec, typeOnly: Boolean(match[2]) })
  }
  return found
}

const problems: string[] = []
const fail = (file: string, message: string) => problems.push(`${relative(ROOT, file)}: ${message}`)
if (PROVIDER_ID === null)
  problems.push('apps/control/src/infra: no MinecraftRuntime declares its provider id')

for (const file of files(CONTROL)) {
  const layer = layerOf(file)
  if (layer === null) {
    fail(file, `sits outside every layer (${LAYERS.join(', ')})`)
    continue
  }
  const source = readFileSync(file, 'utf8')
  const isTest = file.endsWith('.test.ts')
  // Test support stands in for the outside world, as tests do, so it may name its hosts and ports.
  const isTestCode = isTest || layer === 'testing'

  for (const { spec, typeOnly } of imports(source)) {
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec)
      const targetLayer = layerOf(target)
      const targetRel = relative(CONTROL, target)
      const allowed: Record<Layer, (t: Layer | null) => boolean> = {
        domain: (t) => t === 'domain',
        minecraft: (t) => t === 'domain' || t === 'minecraft' || targetRel === 'app/ports/runtime.ts',
        app: (t) => t === 'domain' || t === 'minecraft' || t === 'app',
        infra: (t) =>
          (t === 'app' && targetRel.startsWith('app/ports/')) ||
          (t === 'infra' && targetRel.split('/')[1] === relative(CONTROL, file).split('/')[1]),
        // Services, queries and ports: never another module's persistence (§17).
        interfaces: (t) => (t === 'app' && !targetRel.endsWith('/persistence.ts')) || t === 'interfaces',
        config: (t) => t === 'config' || t === 'domain' || targetRel.startsWith('app/ports/'),
        main: () => true,
        // Test support builds the whole control plane, like main does, and only tests use it.
        testing: () => true,
      }
      if (!allowed[layer](targetLayer) && !isTest) fail(file, `${layer}/ may not import ${targetRel}`)
      if (targetLayer === 'testing' && layer !== 'testing' && !isTest)
        fail(file, `only tests may import ${targetRel}`)
      if (layer === 'minecraft' && targetRel === 'app/ports/runtime.ts' && !typeOnly && !isTest)
        fail(file, 'minecraft/ may import only types from app/ports/runtime.ts')
      // An adapter takes a port's types, the errors it says adapters throw, and the fixed
      // vocabularies (`as const` lists) its types are made of; nothing else.
      if (layer === 'infra' && targetRel.startsWith('app/ports/') && !typeOnly && !isTest) {
        const port = readFileSync(target.endsWith('.ts') ? target : `${target}.ts`, 'utf8')
        for (const name of valueNames(source, spec)) {
          const error = new RegExp(`export class ${name} extends \\w*Error\\b`).test(port)
          const vocabulary = declaresVocabulary(target.endsWith('.ts') ? target : `${target}.ts`, port, name)
          if (!error && !vocabulary)
            fail(
              file,
              `infra/ may import only types, declared errors and vocabularies from ${targetRel}; ${name} is none`,
            )
        }
      }
      // Generated API contracts never leave their adapter, not even into main.
      const contract = /^infra\/([^/]+)\/generated\//.exec(targetRel)?.[1]
      if (contract && !relative(CONTROL, file).startsWith(`infra/${contract}/`))
        fail(file, `the generated ${contract} API types stay inside infra/${contract}/`)
    } else {
      if (
        (layer === 'domain' || layer === 'minecraft') &&
        !PURE_PACKAGES.test(spec) &&
        !(isTest && spec === 'bun:test')
      )
        fail(file, `${layer}/ must stay pure; it imports ${spec}`)
      if (layer === 'app' && !APP_PACKAGES.test(spec) && !(isTest && spec === 'bun:test'))
        fail(file, `app/ may not depend on ${spec}; put it behind a port`)
      if (layer === 'interfaces' && spec.startsWith('@blockly/db') && !isTest)
        fail(file, 'interfaces/ reach the database through app/ services, never directly')
      // A generated client's runtime belongs to the adapters that own a generated contract.
      const adapter = /^infra\/([^/]+)\//.exec(relative(CONTROL, file))?.[1]
      if (spec === 'openapi-fetch' && !(adapter && existsSync(join(CONTROL, 'infra', adapter, 'generated'))))
        fail(
          file,
          'openapi-fetch belongs to an adapter with a generated contract (infra/<adapter>/generated/)',
        )
      if (spec.startsWith('@nats-io/') && adapter !== 'fly')
        fail(file, `${spec} belongs to the Fly adapter in infra/fly/`)
      if (spec.startsWith('@aws-sdk/') && adapter !== 's3')
        fail(file, `${spec} belongs to the S3 adapter in infra/s3/`)
      if (spec.startsWith('@polar-sh/') && adapter !== 'polar')
        fail(file, `${spec} belongs to the Polar adapter in infra/polar/`)
      if (/^transport-io\/(websocket-)?node-transport$/.test(spec) && !file.endsWith('.node.ts'))
        fail(file, `${spec} loads a native binding; import it only from a *.node.ts file`)
    }
  }

  // Deployment domains live in configuration; a provider's hosts in its own adapter (§17).
  if (!isTestCode && layer !== 'config') {
    const adapter = layer === 'infra' ? relative(CONTROL, file).split('/')[1] : null
    for (const match of source.matchAll(HOSTNAME)) {
      const host = match[1] ?? ''
      if (FORMAT_NAMESPACES.test(host)) continue
      if (adapter !== null && PROVIDER_HOSTS[adapter]?.test(host)) continue
      fail(
        file,
        adapter === null
          ? `hostname literal ${host} belongs in configuration`
          : `${host} is no host of infra/${adapter}'s provider`,
      )
    }
  }
  // Access files and console words: the Minecraft translation owns them. The fake runtime stands
  // in for the game itself, so it speaks them too.
  if (!isTestCode && layer !== 'minecraft' && !relative(CONTROL, file).startsWith('infra/fake/'))
    for (const match of withoutComments(source).matchAll(MINECRAFT_WORDS))
      fail(file, `${match[0]} is Minecraft's own vocabulary: it belongs in minecraft/`)
  // Which runtime a deployment runs is the composition root's to know: above the port, a provider
  // id is recorded beside a handle and never named (§8).
  if (PROVIDER_ID !== null && !isTestCode && ABOVE_THE_PORT.has(layer))
    for (const match of withoutComments(source).matchAll(PROVIDER_ID))
      fail(file, `${match[0]} names a runtime: only infra/, config/ and main.node.ts tell runtimes apart`)
  if (
    !isTestCode &&
    layer !== 'minecraft' &&
    layer !== 'config' &&
    /\b25565\b/.test(source.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ''))
  )
    fail(file, "Minecraft's port 25565 belongs in minecraft/ or configuration")
}

// No server column ever holds a hostname: addresses are the slug plus configuration (§5). The
// table is read wherever the schema keeps it: schema.ts, or one of its parts.
const SERVERS_TABLE = /export const minecraftServers = pgTable\([\s\S]*?\n\)/
const schemaFile =
  files(join(ROOT, 'packages/db/src')).find((f) => SERVERS_TABLE.test(readFileSync(f, 'utf8'))) ?? null
const serversTable =
  schemaFile === null ? '' : (SERVERS_TABLE.exec(readFileSync(schemaFile, 'utf8'))?.[0] ?? '')
const schemaPath = schemaFile === null ? 'packages/db/src' : relative(ROOT, schemaFile)
if (serversTable === '') problems.push(`${schemaPath}: minecraftServers table not found`)
for (const match of serversTable.matchAll(/\b(\w*(?:host|domain|fqdn|url|address)\w*)\s*:\s*\w+\(/gi))
  problems.push(`${schemaPath}: minecraft_servers.${match[1]} is hostname-shaped (§5)`)

// The web app may know the API's types, never its code.
for (const file of files(join(ROOT, 'apps/web')).filter((f) => !f.includes('/.next/'))) {
  for (const { spec, typeOnly } of imports(readFileSync(file, 'utf8'))) {
    if (spec.startsWith('@blockly/control') && !typeOnly)
      fail(file, 'the web app may only import types from @blockly/control')
    if (spec.startsWith('@blockly/db')) fail(file, 'the web app never touches the database')
  }
}

// Nor does what the web app is told depend on where servers run: the API's contracts name no runtime.
if (PROVIDER_ID !== null)
  for (const file of files(join(ROOT, 'packages/contracts/src')).filter((f) => !f.endsWith('.test.ts')))
    for (const match of withoutComments(readFileSync(file, 'utf8')).matchAll(PROVIDER_ID))
      fail(file, `${match[0]} names a runtime: the API's contracts never tell runtimes apart`)

if (problems.length > 0) {
  console.error(`Boundary check failed:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.warn('Boundaries hold.')
