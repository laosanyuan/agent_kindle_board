FROM node:22-slim

ENV TZ=Asia/Shanghai

WORKDIR /app

# 中文字体（SVG 渲染依赖）+ 基础工具
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-noto-cjk ca-certificates tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY assets ./assets
COPY config.example.yaml ./config.example.yaml

EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8787/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
