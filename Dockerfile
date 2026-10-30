FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js db.js event-dedupe.js ./
COPY public ./public
COPY data ./data
EXPOSE 3000
CMD ["node", "server.js"]
