FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

ARG HTTP_WEBHOOK_INBOUND_TOKEN
ENV HTTP_WEBHOOK_INBOUND_TOKEN=$HTTP_WEBHOOK_INBOUND_TOKEN
ARG HTTP_WEBHOOK_OUTBOUND_URL
ENV HTTP_WEBHOOK_OUTBOUND_URL=$HTTP_WEBHOOK_OUTBOUND_URL
ARG HTTP_WEBHOOK_OUTBOUND_TOKEN
ENV HTTP_WEBHOOK_OUTBOUND_TOKEN=$HTTP_WEBHOOK_OUTBOUND_TOKEN

ARG OPENCLAW_DOCKER_APT_PACKAGES=""
RUN if [ -n "$OPENCLAW_DOCKER_APT_PACKAGES" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $OPENCLAW_DOCKER_APT_PACKAGES && \
      apt-get clean && \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fi

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN OPENCLAW_A2UI_SKIP_MISSING=1 pnpm build
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:build

ENV NODE_ENV=production

# Install http-webhook plugin
RUN mkdir -p /app/.openclaw/extensions
COPY extensions/http-webhook /app/.openclaw/extensions/http-webhook
RUN cd /app/.openclaw/extensions/http-webhook && npm install --omit=dev

# === Config setup ===

# 1. Bundle default config into image (read-only)
COPY configs/openclaw.json /defaults/openclaw.json

# 2. Persistent runtime directory (Fly volume mount)
WORKDIR /data
VOLUME ["/data"]

# Allow non-root user to write temp files during runtime/tests.
RUN chown -R node:node /app /data /defaults

# Security hardening: Run as non-root user
# The node:22-bookworm image includes a 'node' user (uid 1000)
USER node

# Set home directory for node user so extensions are found
ENV HOME=/app

# 3. Entrypoint handles first-boot init
COPY --chown=node:node entrypoint.sh /entrypoint.sh

# 4. Entrypoint + default command
ENTRYPOINT ["/entrypoint.sh"]
