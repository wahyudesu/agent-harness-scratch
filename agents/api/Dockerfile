# Playwright's image already contains Chromium and every OS library it needs, so
# the agent's browser tools work in production without extra apt packages.
# Keep this tag in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    PORT=3001 \
    BUN_INSTALL=/usr/local/bun \
    PATH=/usr/local/bun/bin:$PATH

# The Playwright image has curl but not unzip, which bun.sh/install requires.
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash \
 && groupadd --gid 10001 agent \
 && useradd --create-home --uid 10001 --gid 10001 agent

WORKDIR /app

# Install from the lockfile first so source edits do not bust the layer cache.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

USER agent
EXPOSE 3001

# Playwright browsers live in the base image; point Bun's runtime at them and
# keep Chromium from trying to sandbox inside the container.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_FLAGS="--no-sandbox"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://localhost:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["bun", "run", "src/index.ts"]
