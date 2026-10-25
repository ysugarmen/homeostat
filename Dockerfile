# Homeostat on a shared box: the dashboard plus the scheduled agents (homeostat up).
#   docker build -t homeostat .
#   docker run -p 4747:4747 -v /path/to/kb-checkout:/kb \
#     -e ANTHROPIC_API_KEY -e HOMEOSTAT_GIT_TOKEN homeostat
# The KB checkout is mounted at /kb; the agents commit and push from it, so it needs a remote
# and credentials the container can use (e.g. an https remote with a token).
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --prod \
  && ln -s /app/packages/cli/bin/homeostat.js /usr/local/bin/homeostat \
  && git config --system --add safe.directory /kb
USER node
EXPOSE 4747
ENTRYPOINT ["homeostat"]
CMD ["up", "--dir", "/kb", "--host", "0.0.0.0", "--port", "4747"]
