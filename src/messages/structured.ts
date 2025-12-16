// Claude Code JSON event types from stream-json output
export interface ClaudeInitEvent {
  type: 'init';
  session_id: string;
}

export interface ClaudeAssistantEvent {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown }>;
  };
}

export interface ClaudeResultEvent {
  type: 'result';
  session_id: string;
  cost_usd?: number;
}

export type ClaudeEvent = ClaudeInitEvent | ClaudeAssistantEvent | ClaudeResultEvent;

// Permission request from MCP tool
export interface PermissionRequest {
  action: string;        // 'bash_command', 'edit_file', etc.
  description: string;   // Human-readable description
  details?: Record<string, unknown>;  // Action-specific details
}

export interface PermissionResult {
  approved: boolean;
  reason?: string;
}

// Agent status for display
export interface AgentStatusInfo {
  id: string;
  type: string;
  status: string;
  workDir: string;
  createdAt: string;
}
