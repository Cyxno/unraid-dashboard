# syntax=docker/dockerfile:1
# Update helper: the ONLY component with Docker access. Single purpose:
# update the unraid-dashboard container to pinned GHCR releases.
# Binds 127.0.0.1 only; token-authenticated; no shell execution.
FROM node:22-alpine
WORKDIR /helper
COPY helper/server.js ./server.js
COPY helper/recreate.js ./recreate.js
COPY helper/compose.js ./compose.js
RUN apk add --no-cache docker-cli docker-cli-compose
ENV HELPER_PORT=8790
# Runs as root: the mounted Docker socket requires it; the container has no
# host paths besides the socket itself.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HELPER_PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
