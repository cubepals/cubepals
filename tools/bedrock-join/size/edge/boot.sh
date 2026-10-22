#!/bin/sh
# A sizing edge's start (size.ts): this checkout's edge, run from source on the load image, because
# a test edge has no image of its own to build. Fetches the pushed commit, mc-router and the pinned
# Geyser, then runs the test relay and sampler beside the agent as the edge image does.
set -eu
cd /edge
pin=$(grep -E '^ARG GEYSER_(VERSION|BUILD|SHA256)=' repo/apps/edge/Dockerfile | cut -d= -f2)
set -- $pin
version=$1 build=$2 sha=$3
curl -fsSL -o geyser.jar "https://download.geysermc.org/v2/projects/geyser/versions/$version/builds/$build/downloads/standalone"
echo "$sha  geyser.jar" | sha256sum -c -
curl -fsSL "https://github.com/itzg/mc-router/releases/download/$MC_ROUTER_VERSION/mc-router_${MC_ROUTER_VERSION}_linux_amd64.tar.gz" | tar xz -C /edge mc-router
export GEYSER_JAR=/edge/geyser.jar ROUTER_BIN=/edge/mc-router
bun repo/tools/bedrock-join/size/edge/probe.ts &
exec bun repo/apps/edge/agent.ts
