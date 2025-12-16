# Agent Chat Service Dockerfile
#
# This image runs the Agent Chat Service and includes Prosody XMPP server.
# Claude Code CLI must be available in the container (mounted or installed).

FROM oven/bun:1-debian AS base

# Install Prosody and dependencies
RUN apt-get update && apt-get install -y \
    prosody \
    lua-dbi-sqlite3 \
    lua-sec \
    lua-bitop \
    lua-event \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install mod_admin_rest for Prosody
RUN mkdir -p /usr/lib/prosody/modules \
    && curl -fsSL https://raw.githubusercontent.com/wltsmrz/mod_admin_rest/master/mod_admin_rest.lua \
       -o /usr/lib/prosody/modules/mod_admin_rest.lua

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN bun run build

# Create directories for Prosody and agent-chat state
RUN mkdir -p /var/lib/prosody \
    && mkdir -p /var/run/prosody \
    && mkdir -p /root/.agent-chat \
    && chown -R prosody:prosody /var/lib/prosody /var/run/prosody

# Copy Prosody configuration
COPY prosody.cfg.lua /etc/prosody/prosody.cfg.lua

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Expose ports
# 5222 - XMPP client connections
# 5280 - Prosody HTTP (admin_rest)
# 3001 - MCP server
EXPOSE 5222 5280 3001

# Environment variables with defaults
ENV XMPP_HOST=localhost \
    XMPP_PORT=5222 \
    XMPP_DOMAIN=localhost \
    XMPP_ADMIN_USERNAME=admin \
    XMPP_ADMIN_PASSWORD=admin \
    MANAGER_USERNAME=manager \
    MANAGER_PASSWORD=manager \
    MCP_PORT=3001 \
    MCP_PERMISSION_TIMEOUT=300000 \
    WORK_BASE_PATH=/work \
    AGENTS_MAX_CONCURRENT=5

# Volume for work directories (repositories)
VOLUME ["/work", "/root/.agent-chat"]

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
