ARG NODE_IMAGE=node:22.19.0-alpine3.22
FROM ${NODE_IMAGE}
WORKDIR /opt/seed
COPY --chown=10001:10001 seed.mjs ./seed.mjs
USER 10001:10001
EXPOSE 8080
CMD ["node", "seed.mjs"]
