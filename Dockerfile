FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_CARTO_API_KEY
ENV VITE_CARTO_API_KEY=$VITE_CARTO_API_KEY
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server.js .
VOLUME /data
EXPOSE 80
CMD ["node", "server.js"]
