# XMPP Agent Chat Service Specification

## Overview

A messaging service that enables bidirectional communication between a single human user and AI coding agents (Claude Code) over XMPP. The service runs on a VPS and provides a chat-based interface for managing and interacting with agents.

**Single-user system:** Designed for one human operator managing multiple agents. No multi-user access control or sharing.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                           VPS                                   │
│  ┌──────────────┐     ┌─────────────────────────────────────┐  │
│  │  XMPP Server │     │        Agent Chat Service           │  │
│  │   (Prosody)  │◄───►│  ┌─────────┐  ┌─────────────────┐   │  │
│  │              │     │  │ Manager │  │  Agent Instances │   │  │
│  │  Users:      │     │  │   Bot   │  │  ┌────────────┐  │   │  │
│  │  - you       │     │  │         │  │  │ Claude Code│  │   │  │
│  │  - manager   │     │  └────┬────┘  │  │   (agent1) │  │   │  │
│  │  - agent1    │     │       │       │  ├────────────┤  │   │  │
│  │  - agent2    │     │       │       │  │   Codex    │  │   │  │
│  │  - ...       │     │       │       │  │   (agent2) │  │   │  │
│  └──────────────┘     │       │       │  └────────────┘  │   │  │
│                       │       ▼       └─────────────────┘   │  │
│                       │  ┌─────────────────────────────┐    │  │
│                       │  │      Work Directory         │    │  │
│                       │  │  ~/work/repo1/              │    │  │
│                       │  │  ~/work/repo2/              │    │  │
│                       │  └─────────────────────────────┘    │  │
│                       └─────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         ▲
         │ XMPP (xmpp-client)
         ▼
┌─────────────────┐
│  Your XMPP      │
│  Client (Beeper,│
│  Conversations, │
│  etc.)          │
└─────────────────┘
```

---

## Components

### 1. XMPP Server (Prosody)

Self-hosted XMPP server handling all messaging.

**Configuration needs:**
- In-band registration disabled (users created programmatically)
- Message archiving for history
- TLS for security
- **XEP-0198 Stream Management** - for connection reliability and message delivery guarantees
- **XEP-0359 Unique Stanza IDs** - for deduplication and response correlation

### 2. Agent Chat Service (This Project)

A Bun TypeScript application with these modules:

#### 2.1 XMPP Client Manager
- Maintains connections for manager bot and all active agents
- Handles message routing
- Uses `@xmpp/client` library

#### 2.2 Manager Bot
- Fixed XMPP user: `manager@domain`
- Handles agent lifecycle (create, list, destroy)
- Conversational interface for spinning up agents

#### 2.3 Agent Registry
- Tracks active agents and their metadata
- Maps XMPP JIDs to agent processes
- Persists state for restart recovery

#### 2.4 Agent Adapters
- Pluggable interface for different agent types
- Each adapter handles:
  - Process spawning
  - Input/output streaming
  - Structured input handling

---

## User Flows

### Flow 1: Spinning Up an Agent

```
You → Manager: "new agent"
Manager → You: "What type of agent? [1] Claude Code [2] Codex"
You → Manager: "1"
Manager → You: "Available repos:
  [1] my-project
  [2] another-repo
  [3] third-repo
Which repo?"
You → Manager: "1"
Manager → You: "What's the initial task for the agent?"
You → Manager: "Fix the login bug in auth.ts"
Manager → You: "✓ Agent 'swift-fox' created. Chat with them at swift-fox@domain"
```

### Flow 2: Chatting with an Agent

```
You → Agent: "Can you look at the auth.ts file and find the bug?"
Agent → You: "I'll read the auth.ts file now."
Agent → You: [streaming chunk 1]
Agent → You: [streaming chunk 2]
Agent → You: "I found the issue. The token validation..."

# Agent needs permission
Agent → You: {
  "type": "permission_request",
  "action": "edit_file",
  "file": "src/auth.ts",
  "preview": "- const valid = token.check()\n+ const valid = await token.check()"
}
You → Agent: "yes" (or "1" for first option)
Agent → You: "File updated successfully."
```

### Flow 3: Shutting Down an Agent

```
You → Agent: "quit"
[Service intercepts "quit" - not sent to Claude]
Agent → You: "Shutting down..."
[Agent process terminated, XMPP user deleted]
Manager → You: "Agent 'swift-fox' has been shut down."
```

**Note:** `quit` is a service-level command intercepted before reaching Claude. Other reserved commands: `status`, `help`.

---

## Message Flow

The service acts as a simple bridge between XMPP and Claude Code's stdio:

1. **Agent → User**: Claude's stdout (JSON stream) → parse → send as XMPP messages
2. **User → Agent**: XMPP messages → queue → write to Claude's stdin as JSON when ready
3. **Permissions**: Handled separately via MCP `permission_prompt` tool (see [MCP Permission Tool](#mcp-permission-tool))

**No special parsing needed** for Claude's questions (e.g., "Which approach? [1] [2] [3]"). The service forwards them as plain text. User replies go back to Claude via stdin, and Claude interprets them.

**Permission requests** are the exception — they come via MCP tool call, block until user responds, and return approval/denial to Claude.

### Message Queueing

User messages are queued and delivered when Claude is ready to receive input:

- Messages received while Claude is processing → queued
- Messages received before agent fully started → queued
- When Claude finishes a turn (emits `result` event) → flush queue to stdin
- If queue grows large, notify user: "Message queued, agent is busy..."

This prevents message loss if user sends input while Claude is mid-response.

---

## Agent Adapter Interface

```typescript
interface AgentAdapter {
  /** Unique identifier for this agent type */
  readonly type: string;

  /** Display name */
  readonly displayName: string;

  /** Spawn a new agent process */
  spawn(config: AgentConfig): Promise<AgentProcess>;
}

interface AgentConfig {
  workDir: string;        // Repo directory
  initialPrompt?: string; // Initial task
}

interface AgentProcess {
  /** Send a message to the agent */
  send(message: string): void;

  /** Stream of output chunks from agent */
  output: AsyncIterable<OutputChunk>;

  /** Kill the agent process */
  kill(): Promise<void>;

  /** Check if process is still running */
  readonly isAlive: boolean;
}

type OutputChunk =
  | { type: 'text'; content: string }
  | { type: 'structured'; data: StructuredMessage };
```

### Built-in Adapters

#### Claude Code Adapter

Uses Claude Code's headless mode with streaming JSON for robust integration.

**Process spawning:**
```bash
claude -p \
  --output-format stream-json \
  --input-format stream-json \
  --permission-prompt-tool mcp__agent_chat__permission_prompt \
  --mcp-config /tmp/agent-chat-{agent-id}-mcp.json
```

The MCP config file is generated per-agent at spawn time (see [MCP Permission Tool](#mcp-permission-tool) section) and points to the shared HTTP MCP server with the agent's ID in the header.

**Key flags:**
- `--output-format stream-json` - JSONL stream on stdout (init → messages → result)
- `--input-format stream-json` - Send user messages as JSONL to stdin (keeps process alive)
- `--permission-prompt-tool` - Routes permission requests through our MCP tool instead of stdout text

**Process model:** One long-lived process per agent. User messages written to stdin as JSONL, responses streamed from stdout as JSONL. Process stays alive across multiple turns.

**Crash recovery fallback:** If the long-lived Claude process exits unexpectedly, respawn a new `claude` process and include `--resume <session_id>` (captured from the most recent `result` event) to continue the same conversation context. If no `session_id` is available, start a fresh session and notify the user.

**MCP Permission Tool:**
We expose an MCP server with a `permission_prompt` tool that:
1. Receives permission request from Claude
2. Formats the request for the human user
3. Sends the prompt in the per-agent chat (message appears from the agent JID)
4. Waits for user response
5. Returns approval/denial to Claude

#### Future Adapters

The adapter interface is designed to support additional AI coding agents beyond Claude Code (e.g., Codex, Aider, other LLM-based tools). Each would need investigation into their CLI capabilities for streaming I/O and permission handling.

---

## Data Model

### Agent Record
```typescript
interface Agent {
  id: string;              // e.g., "swift-fox"
  type: AgentType;         // "claude-code" | ...
  jid: string;             // XMPP JID: "swift-fox@domain"
  workDir: string;         // "/home/user/work/my-project"
  createdAt: Date;
  createdBy: string;       // Your JID
  status: "starting" | "running" | "stopping" | "stopped";
  pid?: number;            // OS process ID
  sessionId?: string;      // Claude Code session ID (for --resume if needed)
}
```

### Agent ID Generation

Agent IDs are auto-generated using `[adjective]-[animal]` format for memorable, easy-to-type names.

**Adjectives:** swift, clever, bold, calm, eager, gentle, happy, keen, lucky, mighty, noble, quick, sharp, wise, brave, bright, cool, fair, grand, jolly

**Animals:** fox, owl, bear, wolf, hawk, deer, lynx, seal, crow, dove, hare, lion, otter, panda, raven, tiger, viper, whale, zebra, badger

Examples: `swift-fox`, `clever-owl`, `bold-bear`, `calm-wolf`

On collision (ID already exists), retry with new random selection. With 20×20=400 combinations, collisions are rare for typical usage.

### Persisted State
```typescript
interface ServiceState {
  agents: Agent[];
  config: {
    workBasePath: string;  // e.g., "/home/user/work"
    xmppDomain: string;
    managerJid: string;
  };
}
```

State persisted to: `~/.agent-chat/state.json`

---

## Manager Bot Commands

Conversational, but also supports direct commands:

| Command | Description |
|---------|-------------|
| `new` / `new agent` / `create` | Start agent creation flow |
| `list` / `agents` | List all active agents |
| `kill <agent-id>` | Force-kill an agent |
| `status <agent-id>` | Get agent status |
| `repos` | List available repositories |
| `help` | Show available commands |

---

## Directory Structure

```
agent-chat/
├── src/
│   ├── index.ts              # Entry point - starts all services
│   ├── config.ts             # Configuration loading
│   ├── xmpp/
│   │   ├── client.ts         # XMPP client wrapper
│   │   ├── manager-bot.ts    # Manager bot logic
│   │   └── agent-bot.ts      # Per-agent XMPP handler
│   ├── agents/
│   │   ├── registry.ts       # Agent registry
│   │   ├── adapter.ts        # Adapter interface
│   │   └── claude-code.ts    # Claude Code adapter
│   ├── mcp/
│   │   ├── server.ts         # HTTP/SSE MCP server (runs in main process)
│   │   ├── router.ts         # Routes tool calls to correct agent
│   │   └── tools/
│   │       └── permission-prompt.ts  # permission_prompt tool
│   ├── messages/
│   │   ├── parser.ts         # Parse incoming messages
│   │   ├── formatter.ts      # Format outgoing messages
│   │   └── structured.ts     # Structured message types
│   └── state/
│       └── persistence.ts    # State persistence
├── plans/
│   └── xmpp-agent-chat-spec.md
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

---

## Configuration

Environment variables or config file (`~/.agent-chat/config.json`):

```typescript
interface Config {
  xmpp: {
    host: string;           // XMPP server host
    port: number;           // Usually 5222
    domain: string;         // XMPP domain
    adminUsername: string;  // For creating users
    adminPassword: string;
  };
  manager: {
    username: string;       // "manager"
    password: string;
  };
  mcp: {
    port: number;           // HTTP MCP server port (default: 3001)
    permissionTimeout: number; // Timeout for permission prompts in ms (default: 300000 = 5 min)
  };
  work: {
    basePath: string;       // "/home/user/work"
  };
  agents: {
    maxConcurrent: number;  // Limit simultaneous agents
    idleTimeout?: number;   // Auto-shutdown after idle (ms)
  };
}
```

---

## Implementation Phases

### Phase 1: Core Infrastructure
- XMPP client wrapper with connection management
- Manager bot with basic message handling
- State persistence

### Phase 2: Agent Lifecycle
- Agent registry
- Agent adapter interface
- Claude Code adapter
- XMPP user creation/deletion

### Phase 3: Message Handling & Permissions
- Output streaming (chunks → XMPP messages)
- Message queueing (user → agent)
- MCP HTTP server for permission prompts
- Permission request/response routing

### Phase 4: Polish
- Error handling and recovery
- Reconnection logic
- Logging
- Graceful shutdown

---

## Technical Decisions

### XMPP Library
Use `@xmpp/client` - most maintained XMPP library for Node.js/Bun.

### XMPP Server
Prosody recommended - lightweight, easy to configure.

**User management:** Use `mod_admin_rest` for programmatic user creation/deletion. It provides a simple REST API:
- `POST /admin/user/{jid}` - create user
- `DELETE /admin/user/{jid}` - delete user

This is cleaner than using mod_register with admin credentials, which is designed for interactive registration flows.

### XMPP Reliability
- **XEP-0198 Stream Management**: Enable for reconnection without message loss
- **XEP-0359 Stanza IDs**: Use for deduplication and correlating responses to requests
- **XEP-0085 Chat State Notifications**: Use for typing indicators (`<composing/>`)
- Handle disconnects gracefully - queue outbound messages during brief disconnects

### Process Management
Use Bun's `spawn()` for agent processes with `stdin: "pipe"` and `stdout: "pipe"`.

**Claude Code process lifecycle:**
```typescript
const args = [
  "claude", "-p",
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--permission-prompt-tool", "mcp__agent_chat__permission_prompt",
  "--mcp-config", mcpConfigPath
];

if (sessionId) args.push("--resume", sessionId);

const proc = Bun.spawn(args, {
  cwd: workDir,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe"
});

// Send user message
proc.stdin.write(JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: userMessage }] }
}) + "\n");

// Read responses
for await (const line of readLines(proc.stdout)) {
  const event = JSON.parse(line);
  // Persist session_id from `result` events for crash recovery (--resume).
  // Forward to XMPP...
}
```

### Streaming Strategy

**Output processing:**
- Read stdout line by line (JSONL format)
- Parse each line as JSON event
- Forward complete `assistant` messages to XMPP (not partial/token-level)
- Handle `init` and `result` events for session management
- Persist `session_id` from each `result` event to the agent record (for `--resume` after crashes)

**Granularity:** Message-by-message, not token-by-token. Each complete assistant message from Claude becomes one XMPP message. This keeps the chat clean and avoids flooding.

**Message limits (prevent flooding):**
- Max message size: 64KB (Prosody default stanza limit)
- Rate limit: Max 10 messages/second per agent (queue excess, warn if sustained)
- Idle detection: Send typing indicator (`<composing/>`) when agent is working

### Structured Messages

**Permission requests** are handled via MCP tool (`--permission-prompt-tool`), not parsed from text.

**For other structured output** (choices, confirmations) from agents that don't support MCP:
- Consider XEP-0335 JSON Containers for XMPP-native structured data
- Fallback: JSON in message body with human-readable rendering
- Avoid text markers like `[STRUCTURED]...[/STRUCTURED]` - prone to injection/collision

### Restart Policy

**Service restart does NOT preserve agent processes.**

On restart:
1. Load persisted registry from `~/.agent-chat/state.json`
2. Mark all agents as `status: "stopped"` (processes are gone)
3. Notify users their agents were stopped due to service restart
4. Users can spawn new agents; no automatic respawn

**Session continuity note:** Persisted `sessionId` enables a future `restart <agent-id>` flow that respawns Claude with `--resume <session_id>` to continue the same conversation context after crashes/restarts.

**Future enhancement:** Run agents in tmux/screen sessions or containers with process supervisors to enable reattachment.

---

## Security Considerations

1. **XMPP TLS**: Always use TLS for XMPP connections
2. **User Isolation**: Each agent runs as a separate XMPP user
3. **Process Isolation**: Consider using containers for agent processes (future)
4. **Permission Auditing**: Log all permission grants
5. **Rate Limiting**: Prevent runaway agents from spamming messages
6. **Agent Passwords**: Can be simple/random — server is on trusted network only. Generated at agent creation, not persisted (regenerated on restart if needed).

---

## MCP Permission Tool

The Agent Chat Service runs a single HTTP-based MCP server that all Claude Code agents connect to for permission handling. This avoids spawning separate MCP processes per agent and keeps all communication within the main service.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                Agent Chat Service                        │
│                                                          │
│  ┌──────────────────┐      ┌────────────────────────┐   │
│  │  MCP HTTP Server │      │   XMPP Connections     │   │
│  │  (SSE transport) │◄────►│   - manager@domain     │   │
│  │  localhost:3001  │      │   - agent1@domain      │   │
│  │                  │      │   - agent2@domain      │   │
│  │  permission_     │      │                        │   │
│  │  prompt tool     │      └────────────────────────┘   │
│  └──────────────────┘                                    │
│          ▲                                               │
└──────────│───────────────────────────────────────────────┘
           │ HTTP (SSE) - each agent connects
           ▼
    ┌──────────────┐
    │ Claude Code  │  (multiple processes, each with own connection)
    │ processes    │
    └──────────────┘
```

### MCP Config (agent-chat-mcp.json)

Generated per-agent with the agent's ID:

```json
{
  "mcpServers": {
    "agent_chat": {
      "type": "sse",
      "url": "http://localhost:3001/mcp",
      "headers": {
        "X-Agent-ID": "claude-a1b2"
      }
    }
  }
}
```

The `X-Agent-ID` header identifies which agent is making the request, allowing the MCP server to route permission prompts to the correct XMPP chat.

### Permission Prompt Tool Schema
```typescript
{
  name: "permission_prompt",
  description: "Request permission from the user for an action",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string" },        // "bash_command", "edit_file", etc.
      description: { type: "string" },   // Human-readable description
      details: { type: "object" }        // Action-specific details (command, file path, etc.)
    },
    required: ["action", "description"]
  }
}
```

### Tool Implementation Flow
1. Claude calls `permission_prompt` tool via HTTP
2. MCP server extracts agent ID from `X-Agent-ID` header
3. Looks up agent in registry → finds XMPP JID and connection
4. Generates a unique request ID (e.g., `perm-a1b2c3`)
5. Formats permission request as human-readable message with ID
6. Sends message via the agent's XMPP connection (appears from agent's JID)
7. Stores pending request: `{ id, agentId, resolve, reject, timeout }`
8. Waits for user response (with configurable timeout, e.g., 5 minutes)
9. Returns `{ approved: true/false, reason?: string }` to Claude

This is synchronous from Claude's perspective — the HTTP request blocks until the user responds or timeout occurs.

### Multiple Concurrent Permissions

Multiple agents may request permissions simultaneously. Each permission gets a unique ID displayed to the user:

```
[agent-1] Permission #a1b2:
  Action: Run bash command
  Command: npm install lodash
  Reply: yes/no (or "a1b2 yes")

[agent-2] Permission #c3d4:
  Action: Edit file
  File: src/auth.ts
  Reply: yes/no (or "c3d4 yes")
```

**Response routing:**
- If user replies to a specific agent chat → matches that agent's oldest pending permission
- If user includes permission ID (e.g., "a1b2 yes") → matches by ID
- If ambiguous, resolve oldest pending permission for that agent

### Timeout Handling

If the user doesn't respond within the timeout:
- Return `{ approved: false, reason: "timeout" }` to Claude
- Claude will see this as a denial and can inform the user or retry
- Remove from pending permissions map

---

## Dependencies

```json
{
  "dependencies": {
    "@xmpp/client": "^0.13.0",
    "@xmpp/debug": "^0.13.0",
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.0.0"
  }
}
```

---

## Example Session

```
# Terminal on VPS
$ bun run src/index.ts
[2024-01-15 10:30:00] Agent Chat Service starting...
[2024-01-15 10:30:01] Connected to XMPP server at chat.example.com
[2024-01-15 10:30:01] Manager bot online: manager@chat.example.com
[2024-01-15 10:30:01] Listening for messages...

# In your XMPP client, message manager@chat.example.com
You: new agent
Manager: What type of agent would you like to create?
  [1] Claude Code - AI coding assistant
  [2] Codex - OpenAI coding assistant
You: 1
Manager: Available repositories in /home/user/work:
  [1] frontend-app
  [2] backend-api
  [3] shared-utils
You: 2
Manager: Describe the task for this agent (or 'skip' for no initial prompt):
You: Investigate why the /users endpoint is slow
Manager: Creating Claude Code agent...
Manager: Agent 'clever-owl' created successfully.
         Chat with it at: clever-owl@chat.example.com

# Now message clever-owl@chat.example.com
You: Start by looking at the users controller
Claude: I'll examine the users controller to understand the endpoint structure.
Claude: Reading src/controllers/users.ts...
Claude: I can see the /users endpoint. Let me trace through the data flow.
Claude: [Permission Request]
        Action: Run bash command
        Command: grep -r "findAll" src/
        Reply: yes/no
You: yes
Claude: Found several usages. The issue appears to be...
...
You: quit
Claude: Shutting down. The investigation notes have been saved.
Manager: Agent 'clever-owl' has been shut down and removed.
```
