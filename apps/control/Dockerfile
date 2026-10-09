# The control plane: one image for the api, worker and realtime roles; ROLES picks which a
# machine runs. Build from the repository root:
#   docker build -f apps/control/Dockerfile -t blockly-control .
# Node runs the TypeScript sources directly (type stripping, Node >= 22.18), as in development.
# Debian trixie, not bookworm: the WebTransport module's prebuilt binary needs glibc 2.38.

# blocklyd, which the node endpoint hands to hosts as they join (FLEET_BLOCKLYD_BIN): built here
# from this commit, so the control plane serves the blocklyd it was built with, with the Rust
# release and Cargo.lock blocklyd.yml builds with. Alpine's Rust targets musl, so the binary is
# static and runs on any Linux host. The layer is reused until apps/blocklyd changes.
FROM rust:1.94.1-alpine3.22 AS blocklyd
RUN apk add --no-cache musl-dev file
WORKDIR /src
COPY apps/blocklyd/Cargo.toml apps/blocklyd/Cargo.lock ./
COPY apps/blocklyd/src src
# The unit `blocklyd join` installs is compiled in.
COPY apps/blocklyd/deploy deploy
RUN cargo build --locked --release \
 && ./target/release/blocklyd --version \
 && file target/release/blocklyd | grep -q 'static' || { file target/release/blocklyd; exit 1; }

FROM node:22.23.2-trixie-slim AS deps
COPY --from=oven/bun:1.3.11 /usr/local/bin/bun /usr/local/bin/bun
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

FROM node:22.23.2-trixie-slim
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
# What the node endpoint serves joining hosts: join.sh and daemon.json, and blocklyd itself.
COPY apps/blocklyd/deploy apps/blocklyd/deploy
COPY --from=blocklyd /src/target/release/blocklyd /usr/local/lib/blocklyd/blocklyd
USER node
WORKDIR /app/apps/control
# The api listener; the internal (edge) and realtime listeners are configured per deployment.
EXPOSE 8080
CMD ["node", "src/main.node.ts"]
