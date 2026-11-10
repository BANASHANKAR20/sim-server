FROM node:20-slim

# Simulators: Icarus Verilog (iverilog + vvp) and GHDL for VHDL
RUN apt-get update \
 && apt-get install -y --no-install-recommends iverilog ghdl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV NODE_ENV=production
CMD ["node", "server.js"]
