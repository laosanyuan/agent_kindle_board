FROM node:22-alpine

ENV TZ=Asia/Shanghai

WORKDIR /app

# 中文字体：文泉驿正黑 16MiB，够用；fonts-noto-cjk 是完整 CJK 字形集（88MiB），面板用不到
# fontconfig 供 sharp 查找字体
# curl：走代理时用它发请求（Cloudflare 会拦 Node undici 的 TLS 指纹，curl 可以过）
RUN apk add --no-cache font-wqy-zenhei fontconfig tzdata curl \
  && fc-cache -f >/dev/null 2>&1

COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund \
  && rm -rf /root/.npm

COPY src ./src
COPY assets ./assets
COPY config.example.yaml ./config.example.yaml

EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8787/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
