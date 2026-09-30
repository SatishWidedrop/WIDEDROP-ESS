# Widedrop ESS — the API and the worker.
#
# One image, two commands: `node dist/server.js` serves requests and
# `node dist/worker.js` drains the outbox. They ship together because they must
# agree about the schema, the encryption key version and the audit chain — a
# worker a release behind the API is a worker writing rows the API will refuse.
#
# Built from the repository root:
#   docker build -f apps/api/Dockerfile -t ess-api .

# ── Stage 1: dependencies ────────────────────────────────────────────
# Split from the build so a source-only change reuses the npm cache layer.
FROM node:22.14-bookworm AS deps

WORKDIR /repo

# Only the manifests, so this layer is invalidated by a dependency change and
# not by every edit to a route.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# `npm ci` against the lockfile: a build that resolves a different version from
# the one that was tested is not the thing that was tested.
RUN npm ci --workspaces --include-workspace-root

# ── Stage 2: build ───────────────────────────────────────────────────
FROM node:22.14-bookworm AS build

WORKDIR /repo
ENV NODE_ENV=development

# The whole installed tree, rather than naming each workspace's
# node_modules. npm hoists to the root and only creates a per-workspace
# node_modules when a version conflict forces one, so naming them individually
# makes the build depend on a resolution detail that changes when a dependency
# does.
COPY --from=deps /repo /repo

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# The shared package first: the API imports its built output.
RUN npm run build -w @widedrop/shared

# Prisma's client is generated, not committed, so the image cannot drift from
# the schema it was built against.
RUN npm run db:generate -w @widedrop/api
RUN npm run build -w @widedrop/api

# Drop everything the runtime does not need, then the sources themselves:
# what ships is the compiled output, the pruned dependencies, the manifests
# and the migrations. Done here so the runtime stage copies one already-clean
# tree rather than reproducing the layout by hand.
#
# The Prisma CLI survives the prune because it is a production dependency, not
# a development one: the platform's pre-deploy step runs `prisma migrate
# deploy` from inside this image. Left in devDependencies it would be pruned
# away here, and `npx` would try to fetch some other version of it from the
# network in the middle of a release.
RUN npm prune --omit=dev --workspaces --include-workspace-root \
  && rm -rf packages/shared/src packages/shared/tsconfig*.json \
            apps/api/src apps/api/tsconfig*.json apps/api/vitest.config.ts

# ── Stage 3: runtime ─────────────────────────────────────────────────
# The full image rather than -slim, and no apt step at all.
#
# Prisma's query engine links against openssl, and TLS to Postgres and to the
# mail provider needs the CA bundle; -slim ships neither, so it would need an
# `apt-get install` — one more thing that can fail at build time for reasons
# that have nothing to do with this code, and one more package set to keep
# patched. The full image carries both already. It is larger; for a service
# running two instances, that is not the constraint worth optimising.
FROM node:22.14-bookworm AS runtime

ENV NODE_ENV=production \
    # The container's clock is UTC and stays UTC. Business time is
    # Asia/Kolkata, which the application applies at the edges where a person
    # reads a date — never by moving the process clock, which would silently
    # shift every stored timestamp.
    TZ=UTC \
    # Node's own defaults are generous for a container with a fixed memory
    # limit; this keeps the heap inside it rather than being OOM-killed.
    NODE_OPTIONS=--max-old-space-size=384

WORKDIR /app

# A non-root user with no shell and no home. If the process is compromised, it
# owns nothing: the application writes to object storage and the database, not
# to the filesystem.
RUN groupadd --system --gid 10001 ess \
  && useradd --system --uid 10001 --gid ess --shell /usr/sbin/nologin --no-create-home ess

# One copy of the pruned tree: the compiled output, the production
# dependencies, the manifests and the migrations — the last so a release can
# apply its own schema change rather than depending on somebody remembering to.
COPY --from=build --chown=root:root /repo /app

# Owned by root, run as ess: the application can read its code and cannot
# modify it.
USER ess:ess

WORKDIR /app/apps/api

EXPOSE 4000

# Node runs as PID 1 and handles SIGTERM itself: server.ts drains in-flight
# requests before exiting, which is what makes a deploy not abort somebody's
# payroll run. There are no child processes to reap, so no init shim is
# bundled; run with `docker run --init` if one is wanted locally.
#
# Exec form, not shell form: a shell between the platform and node would
# swallow the signal and the drain would never start.
#
# Overridden to `node dist/worker.js` for the worker service.
CMD ["node", "dist/server.js"]

# The platform's own health check hits /health/ready, which verifies the
# database. This one is for `docker run` and for a platform that has none.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
