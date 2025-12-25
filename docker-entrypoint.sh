#!/bin/bash
set -e

echo "=== Agent Chat Service Container ==="

# Configure Prosody domain from environment
DOMAIN="${XMPP_DOMAIN:-localhost}"
echo "Configuring Prosody for domain: $DOMAIN"

# Generate TLS certificates if they don't exist
CERT_DIR="/etc/prosody/certs"
CERT_KEY="$CERT_DIR/$DOMAIN.key"
CERT_CRT="$CERT_DIR/$DOMAIN.crt"

if [ ! -f "$CERT_KEY" ] || [ ! -f "$CERT_CRT" ]; then
    echo "Generating self-signed TLS certificates for $DOMAIN..."
    mkdir -p "$CERT_DIR"
    openssl req -new -x509 -days 365 -nodes \
        -out "$CERT_CRT" \
        -keyout "$CERT_KEY" \
        -subj "/CN=$DOMAIN"
    chown prosody:prosody "$CERT_KEY" "$CERT_CRT"
    chmod 600 "$CERT_KEY"
    chmod 644 "$CERT_CRT"
    echo "TLS certificates generated"
else
    echo "Using existing TLS certificates"
fi

# Update Prosody config with actual domain and certificate paths
sed -i "s/VirtualHost \"localhost\"/VirtualHost \"$DOMAIN\"/" /etc/prosody/prosody.cfg.lua
sed -i "s/Component \"admin.localhost\"/Component \"admin.$DOMAIN\"/" /etc/prosody/prosody.cfg.lua
sed -i "s|/etc/prosody/certs/localhost.key|$CERT_KEY|g" /etc/prosody/prosody.cfg.lua
sed -i "s|/etc/prosody/certs/localhost.crt|$CERT_CRT|g" /etc/prosody/prosody.cfg.lua
sed -i "s/http_default_host = \"localhost\"/http_default_host = \"$DOMAIN\"/" /etc/prosody/prosody.cfg.lua

# Ensure Prosody directories have correct permissions
chown -R prosody:prosody /var/lib/prosody /var/run/prosody

# Start Prosody in background
echo "Starting Prosody XMPP server..."
prosodyctl start

# Wait for Prosody to be ready
echo "Waiting for Prosody to start..."
for i in {1..30}; do
    if prosodyctl status > /dev/null 2>&1; then
        echo "Prosody is running"
        break
    fi
    sleep 1
done

# Create admin user if it doesn't exist
ADMIN_USER="${XMPP_ADMIN_USERNAME:-admin}"
ADMIN_PASS="${XMPP_ADMIN_PASSWORD:-admin}"
echo "Creating admin user: $ADMIN_USER@$DOMAIN"
prosodyctl register "$ADMIN_USER" "$DOMAIN" "$ADMIN_PASS" 2>/dev/null || echo "Admin user may already exist"

# Create manager user if it doesn't exist
MANAGER_USER="${MANAGER_USERNAME:-manager}"
MANAGER_PASS="${MANAGER_PASSWORD:-manager}"
echo "Creating manager user: $MANAGER_USER@$DOMAIN"
prosodyctl register "$MANAGER_USER" "$DOMAIN" "$MANAGER_PASS" 2>/dev/null || echo "Manager user may already exist"

# Create config file for agent-chat if not mounted
CONFIG_FILE="/root/.agent-chat/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Creating agent-chat config file..."
    cat > "$CONFIG_FILE" << EOF
{
  "xmpp": {
    "host": "${XMPP_HOST:-localhost}",
    "port": ${XMPP_PORT:-5222},
    "domain": "$DOMAIN",
    "adminUsername": "$ADMIN_USER",
    "adminPassword": "$ADMIN_PASS",
    "tls": ${XMPP_TLS:-true}
  },
  "manager": {
    "username": "$MANAGER_USER",
    "password": "$MANAGER_PASS"
  },
  "mcp": {
    "port": ${MCP_PORT:-3001},
    "permissionTimeout": ${MCP_PERMISSION_TIMEOUT:-300000}
  },
  "work": {
    "basePath": "${WORK_BASE_PATH:-/work}"
  },
  "agents": {
    "maxConcurrent": ${AGENTS_MAX_CONCURRENT:-5}
  }
}
EOF
fi

echo "=== Configuration ==="
echo "XMPP Domain: $DOMAIN"
echo "XMPP TLS: ${XMPP_TLS:-true}"
echo "Manager JID: $MANAGER_USER@$DOMAIN"
echo "MCP Port: ${MCP_PORT:-3001}"
echo "Work Path: ${WORK_BASE_PATH:-/work}"
echo "===================="

# Check if Claude Code CLI is available
if command -v claude &> /dev/null; then
    echo "Claude Code CLI: found"
else
    echo "WARNING: Claude Code CLI not found in PATH"
    echo "Agents will not be able to spawn without it"
fi

echo ""
echo "Starting Agent Chat Service..."
echo ""

# Execute the main command (default: node dist/index.js)
exec "$@"
