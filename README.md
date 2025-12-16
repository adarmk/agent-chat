# Agent Chat Service

An XMPP-based messaging service that enables bidirectional communication between human users and AI coding agents (Claude Code).

## Overview

This service allows you to:
- Create and manage AI coding agents via XMPP chat
- Communicate with agents through your favorite XMPP client
- Grant/deny permissions for agent actions in real-time
- Run multiple concurrent agents on different repositories

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.0+)
- [Prosody](https://prosody.im/) XMPP server with `mod_admin_rest` enabled
- [Claude Code](https://claude.ai/claude-code) CLI installed

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd agent-chat

# Install dependencies
bun install
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

## Prosody Setup

1. Install Prosody and enable `mod_admin_rest`:

```lua
-- /etc/prosody/prosody.cfg.lua
modules_enabled = {
    -- ... other modules
    "admin_rest";
}

-- Admin REST configuration
admin_rest_secure = false  -- Set true for HTTPS
```

2. Create the manager user:

```bash
prosodyctl adduser manager@chat.example.com
```

3. Restart Prosody:

```bash
sudo systemctl restart prosody
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

## License

MIT
