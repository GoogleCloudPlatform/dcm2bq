FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY backend ./backend
COPY frontend ./frontend

USER node
EXPOSE 8080
CMD ["npm", "start"]
