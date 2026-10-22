# The machines that load a sizing edge (size.ts): a Java server it routes to, and the clients that
# join it. Build from the repository root.
FROM mirror.gcr.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS bun

FROM mirror.gcr.io/library/eclipse-temurin:25-jre@sha256:dbb43d81099eec91e0800226ed2296d03146ee7857165b95112372ad0d67e87f
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ADD https://piston-data.mojang.com/v1/objects/33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c/server.jar /server/server.jar
WORKDIR /app/tools/bedrock-join
COPY tools/bedrock-join/package.json tools/bedrock-join/bun.lock ./
RUN bun install --frozen-lockfile
COPY tools/bedrock-join/join.ts ./
COPY tools/bedrock-join/size/load/ ./size/load/
COPY scripts/lib/minecraft.ts /app/scripts/lib/minecraft.ts
COPY apps/control/src/minecraft/ports.ts /app/apps/control/src/minecraft/ports.ts
ENTRYPOINT ["/app/tools/bedrock-join/size/load/start.sh"]
CMD ["server"]
