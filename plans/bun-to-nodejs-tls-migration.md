# Migration Plan: Bun to Node.js + TLS Enablement

## Overview

This plan covers migrating the agent-chat service from Bun runtime to Node.js, and enabling TLS for secure XMPP communication. The migration is necessary because Bun has TLS issues that prevent proper secure communication, while Node.js works correctly.

## Current State Analysis

### Bun-Specific APIs in Use

| File | Line | Bun API | Node.js Replacement |
|------|------|---------|---------------------|
| `src/agents/claude-code.ts` | 8, 297 | `Bun.spawn`, `Subprocess` type | `child_process.spawn`, `ChildProcess` type |
| `src/config.ts` | 41-42 | `Bun.file().exists()`, `Bun.file().json()` | `fs/promises.readFile` + `JSON.parse` |
| `src/state/persistence.ts` | 62-65 | `Bun.file().exists()`, `Bun.file().json()` | `fs/promises.readFile` + `JSON.parse` |
| `src/state/persistence.ts` | 98 | `Bun.write()` | `fs/promises.writeFile()` |
| `src/mcp/server.ts` | 35, 48 | `Bun.serve()` | Node.js `http.createServer()` |

### TLS Configuration Points

1. **Prosody XMPP Server** (`/etc/prosody/prosody.cfg.lua`)
   - Currently: TLS module disabled, `c2s_require_encryption = false`
   - Target: TLS enabled with certificates

2. **XMPP Client** (`src/xmpp/client.ts`)
   - Currently: `xmpp://` protocol (unencrypted)
   - Target: `xmpps://` protocol with TLS configuration

---

## Phase 1: Update Build Configuration

### 1.1 Update package.json

```json
{
  "name": "agent-chat",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "build:check": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.9.3"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.25.1",
    "@xmpp/client": "^0.14.0",
    "@xmpp/debug": "^0.14.0"
  }
}
```

### 1.2 Update tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Phase 2: Replace Bun APIs with Node.js Equivalents

### 2.1 Update `src/config.ts`

Replace Bun file reading with Node.js fs/promises:

```typescript
// Before
const file = Bun.file(configPath);
if (await file.exists()) {
  const fileConfig = await file.json();
  return mergeWithEnv(fileConfig);
}

// After
import { readFile, access } from 'node:fs/promises';

try {
  await access(configPath);
  const content = await readFile(configPath, 'utf-8');
  const fileConfig = JSON.parse(content);
  return mergeWithEnv(fileConfig);
} catch (e) {
  // File doesn't exist or is invalid
}
```

### 2.2 Update `src/state/persistence.ts`

Replace Bun file operations:

```typescript
// Before - load()
const file = Bun.file(this.statePath);
if (await file.exists()) {
  const loadedState = await file.json();
  // ...
}

// After - load()
import { readFile, writeFile, access } from 'node:fs/promises';

try {
  await access(this.statePath);
  const content = await readFile(this.statePath, 'utf-8');
  const loadedState = JSON.parse(content);
  // ...
} catch (e) {
  // File doesn't exist
}

// Before - save()
await Bun.write(this.statePath, JSON.stringify(this.state, null, 2));

// After - save()
await writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
```

### 2.3 Update `src/agents/claude-code.ts`

Replace Bun.spawn with child_process.spawn:

```typescript
// Before
import type { Subprocess } from 'bun';

const proc = Bun.spawn(args, {
  cwd: config.workDir,
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env, CLAUDE_HEADLESS: '1' },
});

// After
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

const proc = spawn(args[0], args.slice(1), {
  cwd: config.workDir,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CLAUDE_HEADLESS: '1' },
});
```

**Key differences to handle:**
- Bun's `proc.stdin.write()` → Node's `proc.stdin.write()` (similar)
- Bun's `proc.stdout.getReader()` → Node's `proc.stdout` as readable stream
- Bun's `proc.exited` → Node's `proc.on('exit', callback)`
- Bun's `proc.killed` → Node's `proc.killed`
- Bun's `proc.exitCode` → Node's `proc.exitCode`
- Bun's `proc.kill()` → Node's `proc.kill()`

**Stream reading adaptation:**

```typescript
// Before (Bun - Web Streams API)
const reader = this.proc.stdout.getReader();
const { done, value } = await reader.read();

// After (Node.js - async iterator)
for await (const chunk of this.proc.stdout) {
  // Process chunk
}
// Or use readline for line-by-line:
import { createInterface } from 'node:readline';
const rl = createInterface({ input: this.proc.stdout });
for await (const line of rl) {
  // Process line
}
```

### 2.4 Update `src/mcp/server.ts`

Replace Bun.serve with Node.js http server:

```typescript
// Before
import type { Server } from 'bun';
private httpServer: ReturnType<typeof Bun.serve> | null = null;

this.httpServer = Bun.serve({
  port: this.port,
  fetch: (req) => this.handleRequest(req),
});

this.httpServer.stop();

// After
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

private httpServer: Server | null = null;

async start(port: number = 3001): Promise<void> {
  this.port = port;

  this.httpServer = createServer(async (req, res) => {
    try {
      // Convert Node.js request to Web Request
      const url = `http://localhost:${this.port}${req.url}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
      }

      // Read body for POST requests
      let body: string | undefined;
      if (req.method === 'POST') {
        body = await new Promise<string>((resolve) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => resolve(data));
        });
      }

      const webRequest = new Request(url, {
        method: req.method,
        headers,
        body: body,
      });

      const response = await this.handleRequest(webRequest);

      // Send response
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      const responseBody = await response.text();
      res.end(responseBody);
    } catch (error) {
      console.error('Error handling request:', error);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  await new Promise<void>((resolve) => {
    this.httpServer!.listen(this.port, () => {
      console.log(`MCP Server started on http://localhost:${this.port}`);
      resolve();
    });
  });
}

async stop(): Promise<void> {
  // ... cleanup connections ...

  if (this.httpServer) {
    await new Promise<void>((resolve) => {
      this.httpServer!.close(() => resolve());
    });
    this.httpServer = null;
  }
}
```

---

## Phase 3: Enable TLS

### 3.1 Update XMPP Client Configuration

Add TLS support to `src/xmpp/client.ts`:

```typescript
export interface XMPPClientConfig {
  host: string;
  port: number;
  domain: string;
  username: string;
  password: string;
  tls?: boolean;  // New: enable TLS
}

async connect(): Promise<void> {
  // ...

  const protocol = this.config.tls ? 'xmpps' : 'xmpp';

  const xmppClient = client({
    service: `${protocol}://${this.config.host}:${this.config.port}`,
    domain: this.config.domain,
    username: this.config.username,
    password: this.config.password,
  });

  // ...
}
```

### 3.2 Update Config Interface

Add TLS option to `src/config.ts`:

```typescript
export interface XmppConfig {
  host: string;
  port: number;
  domain: string;
  adminUsername: string;
  adminPassword: string;
  tls: boolean;  // New
}

// In mergeWithEnv:
xmpp: {
  host: process.env.XMPP_HOST || fileConfig.xmpp?.host || 'localhost',
  port: parseInt(process.env.XMPP_PORT || '') || fileConfig.xmpp?.port || 5222,
  domain: process.env.XMPP_DOMAIN || fileConfig.xmpp?.domain || 'localhost',
  adminUsername: process.env.XMPP_ADMIN_USERNAME || fileConfig.xmpp?.adminUsername || 'admin',
  adminPassword: process.env.XMPP_ADMIN_PASSWORD || fileConfig.xmpp?.adminPassword || '',
  tls: (process.env.XMPP_TLS || fileConfig.xmpp?.tls || 'true') === 'true',  // New
},
```

### 3.3 Update Prosody Configuration

Update `/etc/prosody/prosody.cfg.lua`:

```lua
-- Enable TLS module
modules_enabled = {
    -- Core
    "roster";
    "saslauth";
    "tls";  -- ENABLED: TLS for secure connections
    "dialback";
    "disco";
    "ping";
    "posix";

    -- Chat features
    "carbons";
    "offline";
    "blocklist";
    "vcard4";
    "vcard_legacy";

    -- Reliability
    "smacks";

    -- Admin
    "admin_adhoc";
    "admin_shell";
    "admin_rest";
}

-- TLS/SSL Configuration
ssl = {
    key = "/etc/prosody/certs/chat-server.key";
    certificate = "/etc/prosody/certs/chat-server.crt";
    -- For self-signed certs or internal use:
    -- cafile = "/etc/prosody/certs/ca.crt";
}

-- Require encryption for client connections
c2s_require_encryption = true

-- Virtual host with TLS
VirtualHost "chat-server.cod-hexatonic.ts.net"
    enabled = true
    allow_registration = false

    ssl = {
        key = "/etc/prosody/certs/chat-server.cod-hexatonic.ts.net.key";
        certificate = "/etc/prosody/certs/chat-server.cod-hexatonic.ts.net.crt";
    }
```

### 3.4 Certificate Setup

For Tailscale domain, use Tailscale's built-in certificates:

```bash
# Generate Tailscale HTTPS certificates
tailscale cert chat-server.cod-hexatonic.ts.net

# Copy to Prosody certs directory
sudo mkdir -p /etc/prosody/certs
sudo cp chat-server.cod-hexatonic.ts.net.crt /etc/prosody/certs/
sudo cp chat-server.cod-hexatonic.ts.net.key /etc/prosody/certs/
sudo chown prosody:prosody /etc/prosody/certs/*
sudo chmod 600 /etc/prosody/certs/*.key
```

---

## Phase 4: Update Docker Configuration

### 4.1 Update Dockerfile

```dockerfile
# Agent Chat Service Dockerfile - Node.js version

FROM node:22-slim AS base

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

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Create directories
RUN mkdir -p /var/lib/prosody \
    && mkdir -p /var/run/prosody \
    && mkdir -p /root/.agent-chat \
    && mkdir -p /etc/prosody/certs \
    && chown -R prosody:prosody /var/lib/prosody /var/run/prosody

# Copy Prosody configuration
COPY prosody.cfg.lua /etc/prosody/prosody.cfg.lua

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 5222 5280 3001

ENV XMPP_HOST=localhost \
    XMPP_PORT=5222 \
    XMPP_DOMAIN=localhost \
    XMPP_TLS=true \
    XMPP_ADMIN_USERNAME=admin \
    XMPP_ADMIN_PASSWORD=admin \
    MANAGER_USERNAME=manager \
    MANAGER_PASSWORD=manager \
    MCP_PORT=3001 \
    MCP_PERMISSION_TIMEOUT=300000 \
    WORK_BASE_PATH=/work \
    AGENTS_MAX_CONCURRENT=5

VOLUME ["/work", "/root/.agent-chat", "/etc/prosody/certs"]

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
```

### 4.2 Update docker-entrypoint.sh

Update the entrypoint to handle TLS certificates and Node.js:

```bash
#!/bin/bash
# ... existing setup ...

# Ensure TLS certificates exist (or generate self-signed for development)
if [ ! -f "/etc/prosody/certs/${XMPP_DOMAIN}.crt" ]; then
    echo "Generating self-signed TLS certificates for ${XMPP_DOMAIN}..."
    openssl req -new -x509 -days 365 -nodes \
        -out "/etc/prosody/certs/${XMPP_DOMAIN}.crt" \
        -keyout "/etc/prosody/certs/${XMPP_DOMAIN}.key" \
        -subj "/CN=${XMPP_DOMAIN}"
    chown prosody:prosody /etc/prosody/certs/*
    chmod 600 /etc/prosody/certs/*.key
fi

# ... rest of setup ...
```

---

## Phase 5: Update Type Definitions

### 5.1 Remove Bun Types

Remove from `package.json`:
```json
"devDependencies": {
  "@types/bun": "latest"  // REMOVE THIS
}
```

### 5.2 Fix Timer Type

In `src/xmpp/client.ts`, the `Timer` type from Bun should be replaced:

```typescript
// Before
private reconnectTimer: Timer | null = null;

// After
private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
```

---

## Implementation Order

1. **Phase 1**: Update build configuration (package.json, tsconfig.json)
2. **Phase 2.1**: Update config.ts (simplest file change)
3. **Phase 2.2**: Update persistence.ts (similar to config.ts)
4. **Phase 2.3**: Update claude-code.ts (most complex - process spawning)
5. **Phase 2.4**: Update mcp/server.ts (HTTP server)
6. **Phase 3.1-3.2**: Update XMPP client and config for TLS support
7. **Phase 3.3-3.4**: Update Prosody config and set up certificates
8. **Phase 4**: Update Docker configuration
9. **Phase 5**: Clean up types

---

## Testing Checklist

- [ ] `npm run build` completes without errors
- [ ] `npm run build:check` shows no TypeScript errors
- [ ] Service starts successfully with `npm start`
- [ ] Manager bot connects to XMPP server
- [ ] Agent creation works
- [ ] Agent process spawning works
- [ ] MCP server accepts connections
- [ ] XMPP messages flow correctly
- [ ] TLS handshake succeeds
- [ ] Docker build succeeds
- [ ] Docker container runs correctly

---

## Rollback Plan

If issues are encountered:
1. Keep the original Bun-based code in a `bun-backup` branch
2. The migration can be done incrementally, testing each phase
3. Environment variable `XMPP_TLS=false` can disable TLS if certificate issues occur

---

## Files Changed Summary

| File | Changes |
|------|---------|
| `package.json` | Remove Bun deps, add Node.js deps, update scripts |
| `tsconfig.json` | Update for Node.js module resolution and output |
| `src/config.ts` | Replace `Bun.file` with `fs/promises` |
| `src/state/persistence.ts` | Replace `Bun.file` and `Bun.write` with `fs/promises` |
| `src/agents/claude-code.ts` | Replace `Bun.spawn` with `child_process.spawn`, update stream handling |
| `src/mcp/server.ts` | Replace `Bun.serve` with `http.createServer` |
| `src/xmpp/client.ts` | Add TLS support, fix Timer type |
| `/etc/prosody/prosody.cfg.lua` | Enable TLS, configure certificates |
| `Dockerfile` | Change to Node.js base image, update build commands |
| `docker-entrypoint.sh` | Add TLS certificate handling |
