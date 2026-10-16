# The edge: mc-router, supervised by the edge agent. Build from the repository root:
#   docker build -f apps/edge/Dockerfile .
# Base images come from Google's mirror of Docker Hub, pinned by digest, as in
# apps/control/Dockerfile; mc-router from its own releases on GitHub's registry.
FROM ghcr.io/itzg/mc-router:1.47.1@sha256:177433dd91507339924d60205a19ae9a289afd0e69dbad54e1a55d497f7523f8 AS router

FROM mirror.gcr.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS agent
WORKDIR /build
# The agent imports only types from the contracts, plus play-today.ts (with the units of time it
# imports), edge-poll.ts, proxy-header.ts, server-list.ts and Minecraft's ports, which import
# nothing else, so it compiles without installing anything.
COPY apps/edge/agent.ts apps/edge/asleep.ts apps/edge/clients.ts apps/edge/front.ts apps/edge/header.ts apps/edge/hold.ts apps/edge/limits.ts apps/edge/mappings.ts apps/edge/notice.ts apps/edge/ping-wake.ts apps/edge/poll.ts apps/edge/router.ts apps/edge/
COPY packages/contracts/src/durations.ts packages/contracts/src/edge-poll.ts packages/contracts/src/play-today.ts packages/contracts/src/proxy-header.ts packages/contracts/src/server-list.ts packages/contracts/src/
COPY apps/control/src/minecraft/ports.ts apps/control/src/minecraft/
RUN bun build apps/edge/agent.ts --compile --outfile /build/edge-agent

FROM mirror.gcr.io/library/debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
COPY --from=router /mc-router /mc-router
COPY --from=agent /build/edge-agent /edge-agent
USER 65532
EXPOSE 25565
ENTRYPOINT ["/edge-agent"]
