# 棋类对战平台容器（适用于 Hugging Face Spaces / 任何 Docker 平台）
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
COPY portal-server.js ttt-server.js othello-server.js quoridor-server.js ./
COPY 二阶井字棋-联机版.html 黑白棋-联机对战.html 墙棋-联机对战.html ./
# HF Spaces 要求监听 7860；portal-server.js 读取 PORT 环境变量
ENV PORT=7860
EXPOSE 7860
CMD ["node", "portal-server.js"]
