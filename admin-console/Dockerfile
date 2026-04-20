FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node backend ./backend
COPY --chown=node:node frontend ./frontend

USER node
EXPOSE 8080
CMD ["node", "backend/src/index.js"]
