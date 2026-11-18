# syntax=docker/dockerfile:1.10
# SPDX-FileCopyrightText: 2026 The Cubepals Authors
#
# SPDX-License-Identifier: AGPL-3.0-only

# The image every Minecraft server runs: Eclipse Temurin's JRE with itzg/docker-minecraft-server's
# start scripts and tools, at the release `runtime-spec.ts` pins (2026.9.1), built the way that
# image is built but with only the packages those scripts and Cubepals' own steps call. itzg's
# image installs 168.6 MB of packages for every way anyone runs it (ImageMagick, git, MySQL's
# client, NFS, knockd and more); a new server's first start on Fly pulls all of it.
#
# Nothing of itzg's is copied into this repository: the scripts are taken from their repository at
# a pinned commit, and the tools from their releases, as the upstream Dockerfile takes them. Their
# licences are recorded in LICENSING.md: the scripts, mc-server-runner, rcon-cli, restify and gosu
# under Apache-2.0, mc-image-helper, mc-monitor and CreeperHost's Log4jPatcher under MIT.
#
# What is left out, and why nothing needs it:
#   - ImageMagick: the scripts call `identify` and `convert` only for a server icon that isn't
#     already a 64x64 PNG. Every icon Cubepals hands a server is one (its own, and an owner's,
#     checked as it is uploaded), and the icon step puts it in place itself.
#   - knockd, libpcap, net-tools: autopause, which Cubepals turns off (ENABLE_AUTOPAUSE=FALSE).
#   - git, git-lfs, mysql-client, nfs-common, nano, lbzip2, iputils-ping, iproute2, sudo,
#     libnuma, libcap2-bin, jattach: called by no script of this release, nor by Cubepals.
#   - The HEALTHCHECK: Fly ignores it, and the Docker and Boat runtimes turn it off.
#
# One is built per Java release `javaFor` picks, each on the base itzg builds that Java on at the
# pinned release (its .github/workflows/build.yml), from Google's mirror of Docker Hub:
#   Java 25: eclipse-temurin:25-jre (Ubuntu 24.04)
#   Java 21: eclipse-temurin:21-jre (Ubuntu 24.04)
#   Java 17: eclipse-temurin:17-jre-focal, as Minecraft's Netty fails on newer Ubuntu
#   Java 8:  eclipse-temurin:8u312-b07-jre-focal, as Forge fails past 8u312, with
#            MC_HELPER_VERSION=1.51.4-java8, the last mc-image-helper that runs on Java 8
# From the repository root:
#   docker build --build-arg BASE=mirror.gcr.io/library/eclipse-temurin:25-jre -t <tag> images/minecraft-server

ARG BASE=mirror.gcr.io/library/eclipse-temurin:25-jre

# itzg/docker-minecraft-server at tag 2026.9.1. A new release is a deliberate bump, here and in
# runtime-spec.ts together, with the tool versions below taken from that release's Dockerfile.
FROM scratch AS scripts
ADD --keep-git-dir=false https://github.com/itzg/docker-minecraft-server.git#556afff5c29b7cf752b01edc26508168f5e15c9e /

# The tools, fetched apart so the server image keeps only the binaries.
FROM ${BASE} AS tools
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
ARG GITHUB=https://github.com/itzg
ARG RESTIFY_VERSION=1.7.17
ARG RCON_CLI_VERSION=1.7.7
ARG MC_MONITOR_VERSION=0.17.1
ARG MC_SERVER_RUNNER_VERSION=1.15.2
ARG MC_HELPER_VERSION=1.68.0
RUN set -eu; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates; \
    mkdir -p /out/bin /out/share; \
    arch="${TARGETARCH}${TARGETVARIANT}"; \
    for tool in restify:${RESTIFY_VERSION} rcon-cli:${RCON_CLI_VERSION} mc-monitor:${MC_MONITOR_VERSION} \
        mc-server-runner:${MC_SERVER_RUNNER_VERSION}; do \
      name=${tool%%:*}; version=${tool#*:}; \
      curl -fsSL "${GITHUB}/${name}/releases/download/${version}/${name}_${version}_${TARGETOS}_${arch}.tar.gz" \
        | tar -xzf - -C /out/bin "${name}"; \
    done; \
    curl -fsSL "${GITHUB}/mc-image-helper/releases/download/${MC_HELPER_VERSION}/mc-image-helper-${MC_HELPER_VERSION}.tgz" \
      | tar -xzf - -C /out/share; \
    mv "/out/share/mc-image-helper-${MC_HELPER_VERSION}" /out/share/mc-image-helper; \
    curl -fsSL -o /out/share/Log4jPatcher.jar \
      https://github.com/CreeperHost/Log4jPatcher/releases/download/v1.0.1/Log4jPatcher-1.0.1.jar

FROM ${BASE}

# curl, jq, rsync, unzip and file: the scripts'. zstd: Cubepals' restore reads zstd world
# archives. python3: Paper's class-path start (paper-launch.ts) reads Paperclip's jar with zipfile
# and hashlib, which python3-minimal lacks.
RUN --mount=from=scripts,target=/build,source=/build \
    set -eu; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      curl ca-certificates jq rsync unzip file zstd python3; \
    rm -rf /var/lib/apt/lists/*; \
    /build/ubuntu/setup-user.sh

COPY --from=mirror.gcr.io/tianon/gosu:1.19 /gosu /usr/local/bin/gosu
COPY --from=tools /out/bin/ /usr/local/bin/
COPY --from=tools /out/share/mc-image-helper /usr/share/mc-image-helper
RUN ln -s /usr/share/mc-image-helper/bin/mc-image-helper /usr/bin/mc-image-helper

EXPOSE 25565
VOLUME ["/data"]
WORKDIR /data
STOPSIGNAL SIGTERM
ENV TYPE=VANILLA VERSION=LATEST EULA="" UID=1000 GID=1000 LC_ALL=en_US.UTF-8

COPY --from=scripts --chmod=755 /scripts/ /image/scripts/
COPY --from=scripts --chmod=755 /files/ /image/
COPY --from=tools /out/share/Log4jPatcher.jar /image/Log4jPatcher.jar
RUN set -eu; \
    printf '#!/bin/bash\nexec /image/scripts/start\n' > /start; chmod 755 /start; \
    ln -s /image/scripts/shims/* /usr/local/bin/; \
    sed -i 's/\r$//' /image/scripts/start* /image/scripts/auto/*

ENTRYPOINT ["/image/scripts/start"]

# What the scripts print as the image's own at every start ("[init] Image info: ...").
ARG VERSION=local
ARG REVISION=local
RUN printf 'version=%s\nrevision=%s\n' "${VERSION}" "${REVISION}" > /etc/image.properties
