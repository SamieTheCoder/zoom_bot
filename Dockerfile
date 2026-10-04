FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data DISPLAY=:99 \
    BROWSER_EXECUTABLE=/usr/bin/chromium DESKTOP_ENABLED=true \
    BROWSER_HEADLESS=false HOME=/home/node
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium xvfb x11vnc novnc websockify fluxbox supervisor tini ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY docker/supervisord.conf /etc/supervisor/conf.d/meeting-desk.conf
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN mkdir -p /data /home/node/.config && chown -R node:node /data /home/node \
    && chmod 755 /app/entrypoint.sh
EXPOSE 3000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
