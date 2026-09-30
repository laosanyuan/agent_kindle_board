FROM node:22-slim

WORKDIR /app

# 中文字体（SVG 渲染依赖）+ 基础工具
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-noto-cjk ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY assets ./assets
COPY config.example.yaml ./config.example.yaml

# 挂载点：/app/config.yaml（配置）与 /app/data（历史数据）
VOLUME /app/data

EXPOSE 8787
CMD ["node", "src/index.js"]
