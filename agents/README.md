# minimal-agent

An agent harness you can run locally and deploy behind a reverse proxy.

| Path | What |
| --- | --- |
| `api/` | Hono server: model catalogue, tool surface, `/api/run` (JSON or SSE) |
| `opentui/` | OpenTUI terminal client; fetches the model list from the API |
| `docker-compose.yml` | Production stack for the API |

Harness internals and per-section code are documented in
[`../README.md`](../README.md).

## Local development

```bash
cd api && cp .env.example .env   # set OPENAI_API_KEY (+ EXA_API_KEY for the exa backend)
bun install && bun run dev       # http://localhost:3000

cd ../opentui
bun install && bun run dev       # API_URL defaults to http://localhost:3000
```

The TUI is a terminal program; it never runs in a container. Point it at a
deployed API with `API_URL=https://agent.example.com bun run dev`.

## Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `OPENAI_API_KEY` | — (required) | API: provider key |
| `OPENAI_BASE_URL` | `https://api.groq.com/openai/v1` | API: any OpenAI-compatible gateway |
| `EXA_API_KEY` | — | API: required only for `tools: "exa"` |
| `PORT` | `3000` | API: listen port |
| `API_URL` | `http://localhost:3000` | TUI: where to send requests |

`.env` is git-ignored; `.env.example` is the template. Never commit real keys.

## Deploy

```bash
docker compose up -d --build
docker compose ps                 # api is healthy once /health returns 200
curl -s localhost:3000/api/models
```

What the image does:

- Base is `mcr.microsoft.com/playwright:v1.63.0-noble`, so Chromium and its
  system libraries ship with the image (the `chromium` tools backend). Keep the
  tag in sync with the `playwright` version in `api/package.json`. If you only
  use `tools: "exa"`, swap the base for `oven/bun:1` and drop the Playwright
  layer — the API never launches a browser on that path.
- Dependencies install from `bun.lock` (`--frozen-lockfile`) before source is
  copied, so code edits do not rebuild the dependency layer.
- Runs as an unprivileged user (`uid 10001`), not root.
- `HEALTHCHECK` polls `/health`; `restart: unless-stopped` restarts a wedged
  process.
- `shm_size: 1gb`, because Chromium crashes on Docker's 64 MB default.

`ports` binds `127.0.0.1:3000` on purpose: the API is reachable only through
the proxy on the same host. Put Caddy/Nginx/Traefik in front:

```caddyfile
agent.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Watch the resource shape: a `chromium` run launches its own browser
(about 300–500 MB); an `exa` run is just HTTP calls. One container serialises
fine for a demo, but plan memory before exposing it publicly. Long runs are bounded by
`maxIterations` (default 15) and can be aborted with
`DELETE /api/runs/:id`. Send `accept: text/event-stream` to `POST /api/run` for
live tokens and tool calls; the TUI uses that path.

### Publish the image

```bash
docker build -t ghcr.io/<owner>/minimal-agent-api:latest ./api
docker push ghcr.io/<owner>/minimal-agent-api:latest
```

Then on the server either keep `build: ./api` or replace it with
`image: ghcr.io/<owner>/minimal-agent-api:latest` in `docker-compose.yml`.

## First push to GitHub

From `agent/minimal-agent/`:

```bash
git init
git add .
git status            # confirm no .env is staged
git commit -m "minimal agent harness: API, TUI, deploy"
git branch -M main
git remote add origin git@github.com:<owner>/minimal-agent.git
git push -u origin main
```

If `opentui/` was already its own repository (it started from `create-tui`),
either delete `opentui/.git` to make it part of this repo, or keep it as a
submodule — do not commit both as loose files and as a nested repo.

Checklist before pushing:

- [ ] `git status` shows no `.env` file.
- [ ] `bun run typecheck` passes in both `api/` and `opentui/`.
- [ ] `docker compose config -q` passes.
- [ ] `EXA_API_KEY` is set in `api/.env` if clients will pick `tools: "exa"`.
- [ ] `docker compose up -d --build` then `curl localhost:3000/health` returns 200.
