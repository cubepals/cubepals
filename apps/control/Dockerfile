# The control plane: one image for the api, worker and realtime roles; ROLES picks which a
# machine runs. Build from the repository root:
#   docker build -f apps/control/Dockerfile -t blockly-control .
# Node runs the TypeScript sources directly (type stripping, Node >= 22.18), as in development.
# Debian trixie, not bookworm: the WebTransport module's prebuilt binary needs glibc 2.38.
# No base image comes from Docker Hub, whose outages and rate limits failed builds: Node and Bun
# come from Google's mirror of it (mirror.gcr.io), pinned by digest, the same digest Docker Hub
# serves for the tag. Not ECR's copy (public.ecr.aws): it refuses anonymous pulls past a data limit
# per address, which a shared address reaches. A version bump moves the tag and the digest together.

# blocklyd, which the node endpoint hands to hosts as they join (FLEET_BLOCKLYD_BIN): one release
# of cubepals/blocklyd, static (musl), pinned by digest. `bun scripts/blocklyd.ts bump <version>`
# moves this line and the copies of the release's files beside the fleet adapter together.
FROM ghcr.io/cubepals/blocklyd:0.3.3@sha256:cecec09a52ec48cda3a5053bc896de3e77f355801bb1c47135dbdd500dd283fd AS blocklyd

# The join reporter, the Paper plugin Cubepals places on servers (apps/reporter): built here from
# its sources with the Gradle its wrapper names, and stored as an artifact as the control plane
# starts. Its tests run in CI's own job.
FROM mirror.gcr.io/library/gradle:8.14.3-jdk21@sha256:21bd311ed01360c189b8870c6b6e988199ff10f72d445d02fb39d3cff9da91d7 AS reporter
WORKDIR /build
COPY apps/reporter/settings.gradle.kts apps/reporter/build.gradle.kts ./
COPY apps/reporter/src src
RUN gradle jar --no-daemon --console=plain

FROM mirror.gcr.io/library/node:22.23.4-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf AS deps
COPY --from=mirror.gcr.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
# Only the manifests first, so a source change doesn't reinstall anything.
COPY package.json bun.lock bunfig.toml ./
COPY apps/control/package.json apps/control/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
# Just the control plane's workspaces, at the versions bun.lock pins: the web app's packages would
# be installed otherwise, --filter notwithstanding. Peers are left out too: Better Auth's optional
# peers (next, drizzle-kit) and tRPC's typescript are for other setups and add 500 MB.
RUN bun -e 'const p = await Bun.file("package.json").json(); p.workspaces = ["apps/control", "packages/*"]; delete p.devDependencies; await Bun.write("package.json", JSON.stringify(p))' \
 && bun install --lockfile-only \
 && bun install --production --frozen-lockfile --omit peer
# The WebTransport module's install script (trusted in package.json) fetches its prebuilt native
# binary for this platform.

FROM mirror.gcr.io/library/node:22.23.4-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf
ENV NODE_ENV=production
WORKDIR /app
# Hoisted (bunfig.toml): every dependency lives in the root node_modules, and the workspace
# packages are links into packages/ and apps/, copied next to it.
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY apps/control/package.json apps/control/
COPY apps/control/src apps/control/src
# The server icons game runtimes download as they start: without them every server fails to boot.
COPY apps/control/assets apps/control/assets
COPY --from=reporter /build/build/libs/cubepals-reporter.jar apps/control/assets/reporter/cubepals-reporter.jar
# Cubepals' lockup, which every shared link's picture carries (src/interfaces/http/card.ts).
COPY brand/png/lockup-horizontal.png brand/png/lockup-horizontal.png
# What the node endpoint serves joining hosts: join.sh and daemon.json are in src/infra/fleet, and
# blocklyd itself is the pinned release's. Its licence (FSL-1.1-ALv2) goes with it.
COPY --from=blocklyd /blocklyd /usr/local/lib/blocklyd/blocklyd
COPY --from=blocklyd /LICENSE.md /usr/local/lib/blocklyd/LICENSE.md
USER node
WORKDIR /app/apps/control
# The api listener; the internal (edge) and realtime listeners are configured per deployment.
EXPOSE 8080
CMD ["node", "src/main.node.ts"]
