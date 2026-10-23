# The edge: mc-router and Geyser, supervised by the edge agent. Build from the repository root:
#   docker build -f apps/edge/Dockerfile .
# Base images come from Google's mirror of Docker Hub, pinned by digest, as in
# apps/control/Dockerfile; mc-router from its own releases on GitHub's registry.
#
# Geyser is one build of its standalone jar, pinned here by version, build and hash. To take a newer
# one: `bun scripts/geyser.ts bump` (the latest) or `bun scripts/geyser.ts bump <build>`, which
# rewrites the three lines below; `bun scripts/geyser.ts check` says whether the hash is the build's.
ARG GEYSER_VERSION=2.12.0
ARG GEYSER_BUILD=1268
ARG GEYSER_SHA256=87c8d732c4772b813f65b245acdabf9852af3632854116a312a132568141a348

FROM ghcr.io/itzg/mc-router:1.49.0@sha256:76697861c41e7d64880accf0d25e953a3c2d871e6f5f0922d7c830ffcb2b75ab AS router

FROM scratch AS geyser
ARG GEYSER_VERSION
ARG GEYSER_BUILD
ARG GEYSER_SHA256
ADD --checksum=sha256:${GEYSER_SHA256} --chmod=0644 https://download.geysermc.org/v2/projects/geyser/versions/${GEYSER_VERSION}/builds/${GEYSER_BUILD}/downloads/standalone /Geyser-Standalone.jar

FROM mirror.gcr.io/library/eclipse-temurin:25-jre@sha256:dbb43d81099eec91e0800226ed2296d03146ee7857165b95112372ad0d67e87f AS java

# Geyser's first start fetches the game's own files from Mojang (about 60 MB), which on the edge
# would run inside its first minute and leave Bedrock players waiting on a download after every
# deploy. Here it is started once, until it has them, and what it kept is copied to the image.
FROM java AS warm
COPY --from=geyser /Geyser-Standalone.jar /geyser/Geyser-Standalone.jar
WORKDIR /geyser/warm
RUN set -e; \
    java -Xmx256m -jar /geyser/Geyser-Standalone.jar --nogui > /tmp/warm.log 2>&1 & \
    pid=$!; \
    for i in $(seq 1 240); do grep -q "successfully downloaded" /tmp/warm.log && break; sleep 1; done; \
    kill $pid; cat /tmp/warm.log; \
    test -f cache/client_jar.hash && test -d locales

FROM mirror.gcr.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS agent
WORKDIR /build
# The agent imports only types from the contracts, plus play-today.ts (with the units of time it
# imports), edge-poll.ts, proxy-header.ts, server-list.ts and Minecraft's ports, which import
# nothing else. Its one dependency is OpenTelemetry, for the metrics it serves (metrics.ts): only
# the edge's workspace is installed, at the versions bun.lock pins, as in apps/control/Dockerfile.
COPY package.json bun.lock bunfig.toml ./
COPY apps/edge/package.json apps/edge/
COPY packages/contracts/package.json packages/contracts/
RUN bun -e 'const p = await Bun.file("package.json").json(); p.workspaces = ["apps/edge", "packages/contracts"]; delete p.devDependencies; await Bun.write("package.json", JSON.stringify(p))' \
 && bun install --lockfile-only \
 && bun install --production --frozen-lockfile
COPY apps/edge/agent.ts apps/edge/asleep.ts apps/edge/bedrock-relay.ts apps/edge/bedrock.ts apps/edge/browser-redirect.ts apps/edge/clients.ts apps/edge/example-address.ts apps/edge/forwarding.ts apps/edge/front.ts apps/edge/geyser-config.ts apps/edge/geyser.ts apps/edge/header.ts apps/edge/hold.ts apps/edge/join-trace.ts apps/edge/limits.ts apps/edge/mappings.ts apps/edge/metrics.ts apps/edge/notice.ts apps/edge/ping-wake.ts apps/edge/poll.ts apps/edge/resting.ts apps/edge/router.ts apps/edge/visit-reporter.ts apps/edge/visits.ts apps/edge/
COPY packages/contracts/src/durations.ts packages/contracts/src/edge-poll.ts packages/contracts/src/example-address.ts packages/contracts/src/play-today.ts packages/contracts/src/proxy-header.ts packages/contracts/src/server-list.ts packages/contracts/src/
COPY apps/control/src/minecraft/ports.ts apps/control/src/minecraft/
RUN bun build apps/edge/agent.ts --compile --outfile /build/edge-agent

FROM mirror.gcr.io/library/debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
COPY --from=router /mc-router /mc-router
COPY --from=agent /build/edge-agent /edge-agent
# Geyser's runtime and jar, which the agent starts (apps/edge/bedrock.ts).
COPY --from=java /opt/java/openjdk /opt/java/openjdk
COPY --from=geyser /Geyser-Standalone.jar /geyser/Geyser-Standalone.jar
COPY --from=warm /geyser/warm/cache /geyser/warm/cache
COPY --from=warm /geyser/warm/locales /geyser/warm/locales
ENV PATH=/opt/java/openjdk/bin:$PATH
USER 65532
EXPOSE 25565 8080 19132/udp
ENTRYPOINT ["/edge-agent"]
