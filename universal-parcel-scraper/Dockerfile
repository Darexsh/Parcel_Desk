FROM node:26.12.1-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:26.12.1-trixie-slim
LABEL org.opencontainers.image.source="https://github.com/plhery/universal-parcel-scraper" \
      org.opencontainers.image.licenses="Apache-2.0"
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# The optional transports are devDependencies of the package: without --save-prod, --omit=dev skips them.
RUN npm ci --ignore-scripts --omit=dev \
    && npm install --ignore-scripts --omit=dev --no-save --save-prod playwright-core@1.63.0 sharp@0.35.5 onnxruntime-web@1.30.0 \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/data ./data
COPY LICENSE NOTICE ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 TRACKING_CHROMIUM_PATH=/usr/bin/chromium
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
# Chromium leaves helper processes behind; an init process reaps them.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/cli/index.js", "serve"]
