FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends iverilog ghdl-mcode util-linux \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
USER node
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
