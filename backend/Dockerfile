# Dockerfile for ContextBridge backend — Node.js 20 Alpine image.

FROM node:20-alpine

WORKDIR /app

# Install build tools needed for faiss-node native bindings.
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p data

EXPOSE 3001

CMD ["node", "index.js"]
