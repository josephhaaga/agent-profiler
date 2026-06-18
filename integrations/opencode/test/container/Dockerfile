# E2E container for opencode-agent-profiler plugin testing.
#
# Contains:
#   - Bun (runtime for agent-profiler server + plugin)
#   - opencode CLI (the agent under test)
#   - A pre-built plugin dist (copied from the monorepo)
#   - A fake codebase at /workspace (the agent's working directory)
#
# The container entrypoint runs the sandbox harness (run-e2e.ts) against the
# fake codebase. Hook and span logs are written to /output/ for upload as CI
# artifacts or mounting from the host.
#
# Build:
#   docker build -t ap-e2e -f integrations/opencode/test/container/Dockerfile .
#
# Run (stub mode):
#   docker run --rm -v $(pwd)/e2e-output:/output ap-e2e
#
# Run with --record to capture fixtures:
#   docker run --rm -v $(pwd)/e2e-output:/output ap-e2e \
#     --record my-fixture "Fix the bug in clamp()"
#
# Run against a real provider (mount API key):
#   docker run --rm \
#     -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
#     -v $(pwd)/e2e-output:/output \
#     ap-e2e --mode real --model anthropic/claude-haiku-4-5 "Fix the clamp bug"

FROM debian:bookworm-slim

# ── System deps ────────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# ── Bun ────────────────────────────────────────────────────────────────────────
ARG BUN_VERSION=1.3.13
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun
ENV PATH="/root/.bun/bin:${PATH}"

# ── opencode ───────────────────────────────────────────────────────────────────
ARG OPENCODE_VERSION=1.17.7
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then \
      TARBALL="opencode-linux-arm64.tar.gz"; \
    else \
      TARBALL="opencode-linux-x64.tar.gz"; \
    fi && \
    curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${TARBALL}" \
      -o /tmp/opencode.tar.gz && \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin/ --strip-components=0 && \
    chmod +x /usr/local/bin/opencode && \
    rm /tmp/opencode.tar.gz

# ── Monorepo packages needed by the server ─────────────────────────────────────
WORKDIR /app
COPY bun.lock package.json ./
COPY packages/schema   packages/schema/
COPY packages/store    packages/store/
COPY packages/ingest   packages/ingest/
COPY packages/profiler packages/profiler/
COPY packages/server   packages/server/
COPY packages/web/dist packages/web/dist/
RUN bun install

# ── Pre-built plugin dist ──────────────────────────────────────────────────────
# Copy source and package.json so we can install deps for the target platform.
COPY integrations/opencode/dist        /plugin/dist/
COPY integrations/opencode/package.json /plugin/package.json
# Install plugin dependencies for the container platform (Linux).
# We skip devDependencies and peerDependencies; only runtime deps are needed.
RUN cd /plugin && bun install --production --ignore-scripts

# ── Harness scripts ────────────────────────────────────────────────────────────
COPY integrations/opencode/test/harness /harness/
COPY integrations/opencode/test/fixtures /harness/fixtures/

# ── Fake coding workspace ──────────────────────────────────────────────────────
COPY integrations/opencode/test/container/fake-repo /workspace/

# Give the fake repo a git identity so opencode's git operations work
RUN git -C /workspace init \
    && git -C /workspace config user.email "test@example.com" \
    && git -C /workspace config user.name "Test" \
    && git -C /workspace add -A \
    && git -C /workspace commit -m "initial"

# ── Output dir ─────────────────────────────────────────────────────────────────
RUN mkdir -p /output

# ── Env defaults ───────────────────────────────────────────────────────────────
ENV PLUGIN_DIST=/plugin/dist/index.js
ENV SERVER_SRC=/app/packages/server/src/index.ts
ENV AGENT_PROFILER_WEB_DIST=/app/packages/web/dist
ENV WORKSPACE=/workspace
ENV OUTPUT_DIR=/output
ENV OPENCODE_DISABLE_AUTOUPDATE=1
ENV OPENCODE_DISABLE_LSP_DOWNLOAD=1
ENV OPENCODE_DISABLE_MODELS_FETCH=1

# ── Entrypoint ─────────────────────────────────────────────────────────────────
COPY integrations/opencode/test/container/entrypoint.ts /entrypoint.ts
ENTRYPOINT ["bun", "run", "/entrypoint.ts"]

# Default: stub mode, tool-call-then-text scenario, simple coding prompt
CMD ["Say the word PING and nothing else."]
