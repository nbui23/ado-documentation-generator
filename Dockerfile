FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
ARG VERSION=dev
ARG VCS_REF=unknown
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && mkdir /workspace \
    && chown node:node /workspace
COPY --from=build /app/dist ./dist
LABEL org.opencontainers.image.title="agent-docs" \
      org.opencontainers.image.description="Evidence-backed Azure DevOps documentation generator" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"
USER node
ENTRYPOINT ["node", "dist/cli/main.js"]
