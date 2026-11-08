# Playwright's image already contains Chromium and every OS library it needs, so
# the agent's browser tools work in production without extra apt packages.
# Keep this tag in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    PORT=3001 \
    PATH=/usr/local/bin:$PATH

# The Playwright image ships npm; install bun from the npm registry (@oven/
# bun-linux-x64 is the official binary package). bun.sh/install redirects to
# GitHub releases, which 504s intermittently on CI/build networks.
RUN npm install -g --no-audit --no-fund @oven/bun-linux-x64@1.4.2 \
 && ln -sf "$(npm root -g)/@oven/bun-linux-x64/bin/bun" /usr/local/bin/bun \
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
