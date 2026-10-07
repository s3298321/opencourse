# syntax=docker/dockerfile:1
#
# The OpenCourse catalog server, as one image: the API and the web app.
# Build it from the repository root, because the server compiles in the app's
# pure core and the shared web design layer:
#
#   docker build -f server/Dockerfile -t opencourse-server .
#
# Run it with a volume for /data and the variables in docs/self-hosting.md.

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY server/package.json server/package-lock.json server/.npmrc server/
RUN cd server && npm ci --no-audit --no-fund
COPY app/src/core app/src/core
COPY app/src/main/unzip.ts app/src/main/unzip.ts
COPY design design
COPY server server
RUN cd server && npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    OPENCOURSE_SERVER_HOST=0.0.0.0 \
    OPENCOURSE_SERVER_PORT=8787 \
    OPENCOURSE_SERVER_DATA=/data
WORKDIR /srv
COPY server/package.json server/package-lock.json server/.npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /src/server/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/index.js"]
