import { readFile, access } from 'node:fs/promises';

export interface XmppConfig {
  host: string;
  port: number;
  domain: string;
  adminUsername: string;
  adminPassword: string;
  tls: boolean;
}

export interface ManagerConfig {
  username: string;
  password: string;
}

export interface McpConfig {
  port: number;
  permissionTimeout: number;
}

export interface WorkConfig {
  basePath: string;
}

export interface AgentsConfig {
  maxConcurrent: number;
  idleTimeout?: number;
}

export interface Config {
  xmpp: XmppConfig;
  manager: ManagerConfig;
  mcp: McpConfig;
  work: WorkConfig;
  agents: AgentsConfig;
}

// Load config from ~/.agent-chat/config.json or env vars
export async function loadConfig(): Promise<Config> {
  const configPath = `${process.env.HOME}/.agent-chat/config.json`;

  try {
    await access(configPath);
    const content = await readFile(configPath, 'utf-8');
    const fileConfig = JSON.parse(content);
    return mergeWithEnv(fileConfig);
  } catch (e) {
    // Config file doesn't exist or is invalid
  }

  return getEnvConfig();
}

function mergeWithEnv(fileConfig: Partial<Config>): Config {
  return {
    xmpp: {
      host: process.env.XMPP_HOST || fileConfig.xmpp?.host || 'localhost',
      port: parseInt(process.env.XMPP_PORT || '') || fileConfig.xmpp?.port || 5222,
      domain: process.env.XMPP_DOMAIN || fileConfig.xmpp?.domain || 'localhost',
      adminUsername: process.env.XMPP_ADMIN_USERNAME || fileConfig.xmpp?.adminUsername || 'admin',
      adminPassword: process.env.XMPP_ADMIN_PASSWORD || fileConfig.xmpp?.adminPassword || '',
      tls: (process.env.XMPP_TLS ?? fileConfig.xmpp?.tls?.toString() ?? 'true') === 'true',
    },
    manager: {
      username: process.env.MANAGER_USERNAME || fileConfig.manager?.username || 'manager',
      password: process.env.MANAGER_PASSWORD || fileConfig.manager?.password || '',
    },
    mcp: {
      port: parseInt(process.env.MCP_PORT || '') || fileConfig.mcp?.port || 3001,
      permissionTimeout: parseInt(process.env.MCP_PERMISSION_TIMEOUT || '') || fileConfig.mcp?.permissionTimeout || 300000,
    },
    work: {
      basePath: process.env.WORK_BASE_PATH || fileConfig.work?.basePath || `${process.env.HOME}/work`,
    },
    agents: {
      maxConcurrent: parseInt(process.env.AGENTS_MAX_CONCURRENT || '') || fileConfig.agents?.maxConcurrent || 5,
      idleTimeout: parseInt(process.env.AGENTS_IDLE_TIMEOUT || '') || fileConfig.agents?.idleTimeout,
    },
  };
}

function getEnvConfig(): Config {
  return mergeWithEnv({});
}
