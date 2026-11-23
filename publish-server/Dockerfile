FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    BRIEFKIT_STORAGE_DIR=/briefs \
    BRIEFKIT_RESPONSE_STORAGE_DIR=/responses \
    BRIEFKIT_DEFAULT_DURATION=3mo
COPY package.json server.js replacement.js ./
RUN mkdir -p /briefs /responses && chown -R node:node /briefs /responses /app
USER node
EXPOSE 8080
VOLUME ["/briefs", "/responses"]
CMD ["node", "server.js"]
