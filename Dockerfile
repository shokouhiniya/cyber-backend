FROM node:20

WORKDIR /app

COPY package*.json yarn.lock ./
RUN yarn install

COPY . .
RUN yarn build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Apply idempotent migrations (015+) and one-off data jobs before the API
# starts; a failed migration stops the container instead of booting on a
# half-migrated schema. See scripts/run-migrations.js.
CMD ["sh", "-c", "node scripts/run-migrations.js && node dist/main"]
