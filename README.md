# Agent Chat Service

An XMPP-based messaging service that enables bidirectional communication between human users and AI coding agents (Claude Code).

## Overview

This service allows you to:
- Create and manage AI coding agents via XMPP chat
- Communicate with agents through your favorite XMPP client
- Grant/deny permissions for agent actions in real-time
- Run multiple concurrent agents on different repositories

## Quick Start with Docker (Recommended)

The easiest way to run Agent Chat is with Docker, which bundles Prosody XMPP server.

```bash
# Build the image
docker build -t agent-chat .

# Run with your repositories mounted
docker run -d \
  --name agent-chat \
  -p 5222:5222 \
  -p 3001:3001 \
  -v /path/to/your/repos:/work \
  -v ~/.agent-chat:/root/.agent-chat \
  -e XMPP_DOMAIN=chat.example.com \
  -e XMPP_ADMIN_PASSWORD=your-secure-password \
  -e MANAGER_PASSWORD=your-manager-password \
  agent-chat
```

The container will:
1. Start Prosody XMPP server
2. Create admin and manager users automatically
3. Generate config file from environment variables
4. Start the Agent Chat service

### Docker Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `XMPP_DOMAIN` | XMPP domain for JIDs | `localhost` |
| `XMPP_ADMIN_USERNAME` | Prosody admin username | `admin` |
| `XMPP_ADMIN_PASSWORD` | Prosody admin password | `admin` |
| `MANAGER_USERNAME` | Manager bot username | `manager` |
| `MANAGER_PASSWORD` | Manager bot password | `manager` |
| `MCP_PORT` | MCP HTTP server port | `3001` |
| `MCP_PERMISSION_TIMEOUT` | Permission timeout (ms) | `300000` |
| `WORK_BASE_PATH` | Repository base path | `/work` |
| `AGENTS_MAX_CONCURRENT` | Max concurrent agents | `5` |

### Docker Volumes

| Path | Description |
|------|-------------|
| `/work` | Mount your repositories here |
| `/root/.agent-chat` | Persistent state and config |

### Adding Claude Code to Docker

Claude Code CLI must be available inside the container. Options:

1. **Mount from host** (if Claude Code is installed locally):
   ```bash
   docker run ... -v $(which claude):/usr/local/bin/claude:ro ...
   ```

2. **Install in custom image** - extend the Dockerfile to install Claude Code

3. **Use docker-compose** with a sidecar pattern

## Manual Installation

### Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- [Prosody](https://prosody.im/) XMPP server (v0.12+)
- [Claude Code](https://claude.ai/claude-code) CLI with support for:
  - `--output-format stream-json`
  - `--input-format stream-json`
  - `--permission-prompt-tool`

### Install Dependencies

```bash
# Clone the repository
git clone <repo-url>
cd agent-chat

# Install dependencies
bun install

# Create state directory
mkdir -p ~/.agent-chat
```

## Configuration

Create a configuration file at `~/.agent-chat/config.json`:

```json
{
  "xmpp": {
    "host": "localhost",
    "port": 5222,
    "domain": "chat.example.com",
    "adminUsername": "admin",
    "adminPassword": "your-admin-password"
  },
  "manager": {
    "username": "manager",
    "password": "manager-password"
  },
  "mcp": {
    "port": 3001,
    "permissionTimeout": 300000
  },
  "work": {
    "basePath": "/home/user/repos"
  },
  "agents": {
    "maxConcurrent": 5,
    "idleTimeout": 3600000
  }
}
```

### Configuration Options

| Section | Option | Description | Default |
|---------|--------|-------------|---------|
| `xmpp.host` | XMPP server hostname | `localhost` |
| `xmpp.port` | XMPP server port | `5222` |
| `xmpp.domain` | XMPP domain | `localhost` |
| `xmpp.adminUsername` | Prosody admin username | `admin` |
| `xmpp.adminPassword` | Prosody admin password | Required |
| `manager.username` | Manager bot username | `manager` |
| `manager.password` | Manager bot password | Required |
| `mcp.port` | MCP HTTP server port | `3001` |
| `mcp.permissionTimeout` | Permission request timeout (ms) | `300000` (5 min) |
| `work.basePath` | Directory containing repositories | `~/work` |
| `agents.maxConcurrent` | Max concurrent agents | `5` |

### Environment Variables

All configuration options can also be set via environment variables:

```bash
export XMPP_HOST=localhost
export XMPP_PORT=5222
export XMPP_DOMAIN=chat.example.com
export XMPP_ADMIN_USERNAME=admin
export XMPP_ADMIN_PASSWORD=secret
export MANAGER_USERNAME=manager
export MANAGER_PASSWORD=secret
export MCP_PORT=3001
export MCP_PERMISSION_TIMEOUT=300000
export WORK_BASE_PATH=/home/user/repos
export AGENTS_MAX_CONCURRENT=5
```

## Prosody Setup (Manual Installation)

### 1. Install Prosody

```bash
# Debian/Ubuntu
sudo apt install prosody lua-dbi-sqlite3 lua-sec lua-event

# macOS
brew install prosody
```

### 2. Install mod_admin_rest

`mod_admin_rest` is a community module not included by default:

```bash
# Download the module
sudo curl -fsSL https://raw.githubusercontent.com/wltsmrz/mod_admin_rest/master/mod_admin_rest.lua \
  -o /usr/lib/prosody/modules/mod_admin_rest.lua
```

### 3. Configure Prosody

Edit `/etc/prosody/prosody.cfg.lua`:

```lua
-- Enable required modules
modules_enabled = {
    -- Core
    "roster";
    "saslauth";
    "tls";
    "dialback";
    "disco";
    "ping";

    -- Chat features
    "carbons";
    "offline";

    -- Reliability (recommended)
    "stream_management";  -- XEP-0198: reconnection without message loss

    -- Admin API for user management
    "admin_rest";
}

-- Authentication
authentication = "internal_hashed"

-- HTTP server for admin_rest
http_ports = { 5280 }
http_interfaces = { "127.0.0.1" }  -- Restrict to localhost

-- Your virtual host
VirtualHost "chat.example.com"
    enabled = true
    allow_registration = false
    modules_enabled = { "admin_rest" }
```

### 4. Create Users

```bash
# Create your human user account
prosodyctl adduser you@chat.example.com

# Create the manager bot user
prosodyctl adduser manager@chat.example.com

# Create admin user (for mod_admin_rest)
prosodyctl adduser admin@chat.example.com
```

### 5. Restart Prosody

```bash
sudo systemctl restart prosody
```

### TLS Configuration (Production)

For production deployments, enable TLS:

```lua
-- In prosody.cfg.lua
c2s_require_encryption = true

VirtualHost "chat.example.com"
    ssl = {
        key = "/etc/prosody/certs/chat.example.com.key";
        certificate = "/etc/prosody/certs/chat.example.com.crt";
    }
```

## Running the Service

```bash
# Development
bun run start

# Or directly
bun run src/index.ts
```

### Expected Output

```
[INFO] Agent Chat Service starting...
[INFO] Configuration loaded
[INFO] State loaded
[INFO] Agent registry initialized
[INFO] MCP server started on port 3001
[INFO] Permission prompt tool registered
[INFO] Manager bot started
[INFO] Agent Chat Service started successfully
[INFO] Listening for messages...
```

## Usage

### Connect to the Manager Bot

1. Open your XMPP client (Conversations, Gajim, etc.)
2. Add `manager@chat.example.com` as a contact
3. Start chatting!

### Manager Bot Commands

| Command | Description |
|---------|-------------|
| `new` / `create` | Start agent creation flow |
| `list` / `agents` | List all active agents |
| `kill <agent-id>` | Force-kill an agent |
| `status <agent-id>` | Get agent status |
| `repos` | List available repositories |
| `help` | Show available commands |

### Creating an Agent

```
You: new
Manager: What type of agent? [1] Claude Code
You: 1
Manager: Available repos: [1] my-project [2] another-repo
You: 1
Manager: What's the initial task for the agent?
You: Fix the login bug in src/auth.ts
Manager: Agent swift-fox created. Chat at swift-fox@chat.example.com
```

### Chatting with an Agent

Once created, add the agent's JID to your contacts and chat directly:

```
You: Can you show me the current auth implementation?
swift-fox: [Shows code and explanation]
You: Please add input validation
swift-fox: 🔐 Permission #a1b2
         Action: Edit File
         File: src/auth.ts
         Reply: yes / no
You: yes
swift-fox: [Makes changes and confirms]
```

### Agent Commands

When chatting with an agent:

| Command | Description |
|---------|-------------|
| `quit` / `exit` | Shut down the agent |
| `status` | Show agent status |
| `help` | Show available commands |

## Architecture

```
┌─────────────────┐     XMPP      ┌──────────────────┐
│   XMPP Client   │◄────────────►│   Prosody XMPP   │
│   (User)        │               │   Server         │
└─────────────────┘               └────────┬─────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │  Agent Chat      │
                                  │  Service         │
                                  │                  │
                                  │  ┌────────────┐  │
                                  │  │ Manager    │  │
                                  │  │ Bot        │  │
                                  │  └────────────┘  │
                                  │                  │
                                  │  ┌────────────┐  │
                                  │  │ Agent      │  │
                                  │  │ Handlers   │  │
                                  │  └────────────┘  │
                                  │                  │
                                  │  ┌────────────┐  │
                                  │  │ MCP Server │  │
                                  │  └────────────┘  │
                                  └────────┬─────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │  Claude Code     │
                                  │  Processes       │
                                  └──────────────────┘
```

## File Structure

```
src/
├── index.ts              # Service entry point
├── config.ts             # Configuration loading
├── agents/
│   ├── adapter.ts        # Agent adapter interface
│   ├── claude-code.ts    # Claude Code implementation
│   ├── recovery.ts       # Crash recovery logic
│   └── registry.ts       # Agent registry
├── mcp/
│   ├── server.ts         # MCP HTTP/SSE server
│   ├── router.ts         # Request routing
│   └── tools/
│       └── permission-prompt.ts
├── messages/
│   ├── formatter.ts      # Message formatting
│   ├── parser.ts         # Message parsing
│   └── structured.ts     # Type definitions
├── state/
│   └── persistence.ts    # State persistence
├── utils/
│   ├── logger.ts         # Logging utilities
│   └── message-queue.ts  # Message queuing
└── xmpp/
    ├── admin.ts          # Prosody admin API
    ├── agent-bot.ts      # Per-agent handler
    ├── client.ts         # XMPP client wrapper
    └── manager-bot.ts    # Manager bot
```

## Development

```bash
# Build
bun run build

# Type check
bun run --bun tsc --noEmit
```

## Troubleshooting

### Connection Issues

**"Cannot connect to XMPP server"**
- Verify Prosody is running: `prosodyctl status`
- Check the domain matches your config
- Ensure port 5222 is accessible

**"mod_admin_rest not working"**
- Verify the module is installed: `ls /usr/lib/prosody/modules/mod_admin_rest.lua`
- Check HTTP port 5280 is enabled in Prosody config
- Test the API: `curl http://localhost:5280/admin_rest/`

**"Agent failed to spawn"**
- Verify Claude Code CLI is in PATH: `which claude`
- Check Claude Code supports required flags: `claude --help | grep stream-json`
- Ensure work directory exists and is readable

### Permission Issues

**"Permission request timed out"**
- Default timeout is 5 minutes (configurable via `mcp.permissionTimeout`)
- Check your XMPP client received the permission prompt
- Respond with `yes`, `no`, or the permission ID (e.g., `a1b2 yes`)

### State Recovery

The service persists state to `~/.agent-chat/state.json`. On restart:
- All agent processes are terminated (PIDs become invalid)
- Agents are marked as `stopped`
- Users are notified their agents were shut down
- Agent session IDs are preserved for potential future `--resume` support

### Logs

```bash
# Docker logs
docker logs -f agent-chat

# Prosody logs (manual install)
journalctl -u prosody -f
```

## Security Notes

- **MCP server** runs on localhost only (not exposed externally)
- **Agent passwords** are randomly generated at creation, not persisted
- **Prosody admin API** should be restricted to localhost in production
- **TLS** is recommended for production XMPP deployments
- All permission grants are logged for auditing

## License

MIT
