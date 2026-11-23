FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_PUBLIC_BASE_PATH=/image
ENV NEXT_PUBLIC_API_MODE=same-origin
ENV JAXAPI_BASE_URL=https://jaxapi.top
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_PUBLIC_BASE_PATH=/image
ENV NEXT_PUBLIC_API_MODE=same-origin
ENV JAXAPI_BASE_URL=https://jaxapi.top
COPY --from=build /app/package.json ./
COPY --from=build /app/next.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
EXPOSE 43123
CMD ["npm", "run", "start"]
