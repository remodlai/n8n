ARG NODE_VERSION=22

# 1. Create an image to build n8n
FROM --platform=linux/amd64 n8nio/base:${NODE_VERSION} AS builder

# Build the application from source
WORKDIR /src
COPY . /src
RUN npm install -g pnpm
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store --mount=type=cache,id=pnpm-metadata,target=/root/.cache/pnpm/metadata DOCKER_BUILD=true pnpm install --frozen-lockfile
# Increase Node.js heap size to prevent out of memory errors during build
# Disable Turbo telemetry and cache to avoid filesystem issues in Docker
RUN NODE_OPTIONS="--max-old-space-size=4096" TURBO_TELEMETRY_DISABLED=1 pnpm build --no-cache

# Delete all dev dependencies
RUN node .github/scripts/trim-fe-packageJson.js
# We don't want to remove all patches because we want them still to be applied
# in `pnpm deploy`. However, we need to remove FE patches because we trim the FE
# package.json files and `pnpm deploy` will fail otherwise. element-plus is the
# only FE patch that we need to remove.
RUN jq '.pnpm.patchedDependencies |= with_entries(select(.key | startswith("pdfjs-dist") or startswith("pkce-challenge")))' package.json > package.json.tmp; mv package.json.tmp package.json

# Delete any source code or typings
RUN find . -type f -name "*.ts" -o -name "*.vue" -o -name "tsconfig.json" -o -name "*.tsbuildinfo" | xargs rm -rf

# Deploy the `n8n` package into /compiled
RUN mkdir /compiled
RUN NODE_ENV=production DOCKER_BUILD=true pnpm --filter=n8n --prod --no-optional --legacy deploy /compiled

# 2. Start with a new clean image with just the code that is needed to run n8n
FROM n8nio/base:${NODE_VERSION}
ENV NODE_ENV=production

ARG N8N_RELEASE_TYPE=dev
ENV N8N_RELEASE_TYPE=${N8N_RELEASE_TYPE}

WORKDIR /home/node
COPY --from=builder /compiled /usr/local/lib/node_modules/n8n
COPY docker/images/n8n/docker-entrypoint.sh /

# Setup the Task Runner Launcher
ARG TARGETPLATFORM
ARG LAUNCHER_VERSION=1.1.3
COPY docker/images/n8n/n8n-task-runners.json /etc/n8n-task-runners.json
# Download, verify, then extract the launcher binary
RUN \
	if [[ "$TARGETPLATFORM" = "linux/amd64" ]]; then export ARCH_NAME="amd64"; \
	elif [[ "$TARGETPLATFORM" = "linux/arm64" ]]; then export ARCH_NAME="arm64"; fi; \
	mkdir /launcher-temp && \
	cd /launcher-temp && \
	wget https://github.com/n8n-io/task-runner-launcher/releases/download/${LAUNCHER_VERSION}/task-runner-launcher-${LAUNCHER_VERSION}-linux-${ARCH_NAME}.tar.gz && \
	wget https://github.com/n8n-io/task-runner-launcher/releases/download/${LAUNCHER_VERSION}/task-runner-launcher-${LAUNCHER_VERSION}-linux-${ARCH_NAME}.tar.gz.sha256 && \
	# The .sha256 does not contain the filename --> Form the correct checksum file
	echo "$(cat task-runner-launcher-${LAUNCHER_VERSION}-linux-${ARCH_NAME}.tar.gz.sha256) task-runner-launcher-${LAUNCHER_VERSION}-linux-${ARCH_NAME}.tar.gz" > checksum.sha256 && \
	sha256sum -c checksum.sha256 && \
	tar xvf task-runner-launcher-${LAUNCHER_VERSION}-linux-${ARCH_NAME}.tar.gz --directory=/usr/local/bin && \
	cd - && \
	rm -r /launcher-temp

RUN \
	cd /usr/local/lib/node_modules/n8n && \
	npm rebuild sqlite3 && \
	cd - && \
	ln -s /usr/local/lib/node_modules/n8n/bin/n8n /usr/local/bin/n8n && \
	mkdir .n8n && \
	chown node:node .n8n

# pdfjs-dist has an optional dependency on @napi-rs/canvas, which is required
# for it to work.
RUN cd /usr/local/lib/node_modules/n8n/node_modules/pdfjs-dist && npm install @napi-rs/canvas

# Install npm 11.4.1 to fix the vulnerable cross-spawn dependency
RUN npm install -g npm@11.4.1

ENV SHELL=/bin/sh

USER root
RUN npm install -g \
    neo4j-driver \
    mailgun.js \
    form-data \
    composio-core \
    openai \
    @mendable/firecrawl-js \
    resend \
    @supabase/supabase-js \
	@supabase/ssr \
	@upstash/search \
	random-words \
	sillyname \
	stripe \
    'pinecone5@npm:@pinecone-database/pinecone@5.1.1'

# If any CLI binaries were installed and should be globally available, you can verify PATH here
ENV PATH="/usr/local/bin:$PATH"

USER node
EXPOSE 5678/tcp
ENTRYPOINT ["tini", "--", "/docker-entrypoint.sh"]

   