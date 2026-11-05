# For hosts that run containers (Fly.io, Railway, a VPS). Mount a volume at /data.
FROM node:22-slim
WORKDIR /app
COPY . .
RUN node build.mjs --single
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/dayspear.db
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
