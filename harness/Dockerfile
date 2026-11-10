FROM oven/bun:1.3.13-debian@sha256:e95356cb8e1de62ad69ab3bd3584ba947013d27650a226804d2fc0af4e17dac2 AS bundle

USER root
WORKDIR /opt/ccb
COPY patch-ccb.mjs /tmp/patch-ccb.mjs
ADD https://codeload.github.com/claude-code-best/claude-code/tar.gz/963e0013184ecc1521289a0fc7d5da4bb6e45356 /tmp/ccb.tar.gz
RUN bun /tmp/patch-ccb.mjs /opt/ccb --archive /tmp/ccb.tar.gz \
    && bun install --frozen-lockfile --ignore-scripts \
    && bun run build.ts \
    && mkdir -p /bundle/node_modules \
    && cp -rL node_modules/ws /bundle/node_modules/ws \
    && cp -r dist /bundle/dist \
    && printf '{"type":"module"}\n' > /bundle/package.json

FROM gcc:14.3.0-bookworm@sha256:5e927c284bf55a7dc796262e311a0703344f62f41f5621eb56843111b1d37e15 AS launcher
WORKDIR /build
COPY launch.c .
RUN gcc -std=c17 -O2 -Wall -Wextra -Werror -static -s -o /launch launch.c

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
WORKDIR /opt/harness
COPY --from=bundle /bundle/ /opt/ccb/
COPY --from=launcher /launch /opt/harness/launch
COPY envelope.mjs game-html.mjs model-bridge.mjs network-lock.mjs runtime.mjs workspace.mjs /opt/harness/
USER node
EXPOSE 8080
ENTRYPOINT ["/opt/harness/launch"]
