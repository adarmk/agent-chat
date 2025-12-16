/**
 * Agent Adapter Interface
 *
 * Provides a pluggable interface for different AI coding agents (Claude Code, Codex, etc.)
 * Each adapter handles process spawning, I/O streaming, and structured message handling.
 */

/**
 * Structured message types for agent output
 */
export interface StructuredMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Output chunk types - what comes out of an agent
 */
export type OutputChunk =
  | { type: 'text'; content: string }
  | { type: 'structured'; data: StructuredMessage };

/**
 * Configuration for spawning an agent
 */
export interface AgentConfig {
  /** Repo directory */
  workDir: string;
  /** Initial task */
  initialPrompt?: string;
  /** For MCP config */
  agentId: string;
  /** URL for MCP server */
  mcpServerUrl: string;
  /** Session ID to resume from (optional) */
  resumeSessionId?: string;
}

/**
 * Represents a running agent process
 */
export interface AgentProcess {
  /** Send a message to the agent */
  send(message: string): void;

  /** Stream of output chunks from agent */
  output: AsyncIterable<OutputChunk>;

  /** Kill the agent process */
  kill(): Promise<void>;

  /** Check if process is still running */
  readonly isAlive: boolean;

  /** Session ID for resume capability */
  readonly sessionId?: string;

  /** Callback for when process exits */
  onExit(callback: (exitCode: number | null) => void): void;
}

/**
 * Adapter for a specific agent type (Claude Code, Codex, etc.)
 */
export interface AgentAdapter {
  /** Unique identifier for this agent type */
  readonly type: string;

  /** Display name shown to users */
  readonly displayName: string;

  /** Spawn a new agent process */
  spawn(config: AgentConfig): Promise<AgentProcess>;
}
