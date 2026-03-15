FROM node:24-slim

WORKDIR /app

RUN npm install better-sqlite3 tsx typescript @types/node

COPY dashboard.ts .

EXPOSE 3001

CMD ["npx", "tsx", "dashboard.ts"]
