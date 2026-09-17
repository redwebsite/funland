FROM node:22-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm install --production

# 拷贝代码
COPY . .

# 暴露端口: 8098 (Portal), 8091 (Admin), 8097 (Emby Proxy)
EXPOSE 8098 8091 8097

ENV NODE_ENV=production

CMD ["node", "src/main.js"]
