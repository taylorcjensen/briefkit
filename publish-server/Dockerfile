FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    BRIEFKIT_STORAGE_DIR=/briefs \
    BRIEFKIT_DEFAULT_DURATION=3mo
COPY package.json server.js ./
RUN mkdir -p /briefs && chown -R node:node /briefs /app
USER node
EXPOSE 8080
VOLUME ["/briefs"]
CMD ["node", "server.js"]
