FROM node:lts-slim
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY . .
RUN npm install --production --silent
RUN chown -R node /usr/src/app
USER node
CMD ["node", "index.js", "service"]
