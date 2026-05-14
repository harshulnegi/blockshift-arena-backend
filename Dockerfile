FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY schema.sql ./schema.sql
COPY src ./src
EXPOSE 8080
CMD ["sh", "-c", "node src/db/migrate.js && node src/index.js"]
