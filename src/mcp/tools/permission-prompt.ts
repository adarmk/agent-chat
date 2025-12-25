import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolHandler } from '../server';
import type { AgentRegistry } from '../../agents/registry';
import { logger } from '../../utils/logger';

/**
 * Result of a permission request (internal format)
 */
export interface PermissionResult {
  approved: boolean;
  reason?: string;
}

/**
 * Claude Code permission prompt response format
 */
export interface ClaudePermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

/**
 * Pending permission request
 */
export interface PendingPermission {
  id: string;           // Short unique ID (e.g., 'a1b2')
  agentId: string;
  action: string;
  description: string;
  details?: unknown;
  createdAt: Date;
  resolve: (result: PermissionResult) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

/**
 * Callback function to send messages to users via XMPP
 */
export type SendMessageFn = (agentId: string, message: string) => Promise<void>;

/**
 * MCP tool for requesting permissions from users.
 * Allows Claude agents to ask for permission before performing sensitive actions.
 */
export class PermissionPromptTool {
  private registry: AgentRegistry;
  private sendMessage: SendMessageFn;
  private timeoutMs: number;
  private pending: Map<string, PendingPermission> = new Map();

  constructor(
    registry: AgentRegistry,
    sendMessage: SendMessageFn,
    timeoutMs: number = 300000 // Default 5 minutes
  ) {
    this.registry = registry;
    this.sendMessage = sendMessage;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Get the tool schema for MCP registration
   *
   * Claude Code's --permission-prompt-tool passes:
   * - tool_name: The name of the tool Claude wants to use (e.g., "Bash", "Edit")
   * - input: The arguments for that tool (passthrough object)
   */
  getSchema(): Tool {
    return {
      name: 'permission_prompt',
      description: 'Request permission from the user for an action',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: {
            type: 'string',
            description: 'The name of the tool Claude wants to use',
          },
          input: {
            type: 'object',
            description: 'The input arguments for the tool',
            additionalProperties: true,
          },
        },
        required: ['tool_name', 'input'],
      },
    };
  }

  /**
   * Get the handler function for MCP registration
   */
  getHandler(): ToolHandler {
    return async (args: Record<string, unknown>, agentId: string): Promise<ClaudePermissionResponse> => {
      // Claude Code sends: { tool_name: "Bash", input: { command: "..." } }
      const toolName = (args.tool_name as string) || 'unknown_tool';
      const toolInput = (args.input as Record<string, unknown>) || {};

      // Generate a human-readable description from the tool input
      const description = this.generateDescription(toolName, toolInput);

      logger.debug('Permission prompt called', { agentId, toolName, toolInput });

      const result = await this.requestPermission(
        agentId,
        toolName,
        description,
        toolInput
      );

      // Convert internal result to Claude Code expected format
      // IMPORTANT: updatedInput must be the tool's input, not the wrapper args
      if (result.approved) {
        return {
          behavior: 'allow',
          updatedInput: toolInput,
        };
      } else {
        return {
          behavior: 'deny',
          message: result.reason || 'User denied permission',
        };
      }
    };
  }

  /**
   * Generate a human-readable description from tool name and input
   */
  private generateDescription(toolName: string, input: Record<string, unknown>): string {
    // Try to create a meaningful description based on common tool patterns
    switch (toolName.toLowerCase()) {
      case 'bash':
        return input.command ? `Run command: ${input.command}` : 'Run a shell command';
      case 'edit':
        return input.file_path ? `Edit file: ${input.file_path}` : 'Edit a file';
      case 'write':
        return input.file_path ? `Write file: ${input.file_path}` : 'Write a file';
      case 'read':
        return input.file_path ? `Read file: ${input.file_path}` : 'Read a file';
      case 'glob':
        return input.pattern ? `Search for files: ${input.pattern}` : 'Search for files';
      case 'grep':
        return input.pattern ? `Search content: ${input.pattern}` : 'Search file contents';
      case 'webfetch':
        return input.url ? `Fetch URL: ${input.url}` : 'Fetch a web page';
      case 'websearch':
        return input.query ? `Web search: ${input.query}` : 'Search the web';
      default:
        // For unknown tools, try to summarize the input
        const keys = Object.keys(input);
        if (keys.length > 0) {
          const firstKey = keys[0];
          const firstValue = input[firstKey];
          if (typeof firstValue === 'string' && firstValue.length < 100) {
            return `${toolName}: ${firstValue}`;
          }
        }
        return `Use ${toolName} tool`;
    }
  }

  /**
   * Request permission from the user for an action
   */
  private async requestPermission(
    agentId: string,
    action: string,
    description: string,
    details?: unknown
  ): Promise<PermissionResult> {
    // Verify agent exists
    const agent = this.registry.get(agentId);
    if (!agent) {
      logger.warn('Permission request from unknown agent', { agentId });
      return {
        approved: false,
        reason: 'Agent not found',
      };
    }

    // Generate unique request ID
    const requestId = this.generateRequestId();

    // Create permission message
    const message = this.formatPermissionMessage(requestId, action, description, details);

    // Send message to user
    try {
      await this.sendMessage(agentId, message);
      logger.info('Permission request sent', { agentId, requestId, action });
    } catch (error) {
      logger.error('Failed to send permission request', { agentId, requestId, error });
      return {
        approved: false,
        reason: 'Failed to send permission request',
      };
    }

    // Wait for user response
    return new Promise<PermissionResult>((resolve) => {
      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        logger.info('Permission request timed out', { agentId, requestId, action });
        this.pending.delete(requestId);
        logger.permissionDenied(agentId, action, 'timeout');
        resolve({
          approved: false,
          reason: 'timeout',
        });
      }, this.timeoutMs);

      // Store pending request
      const pending: PendingPermission = {
        id: requestId,
        agentId,
        action,
        description,
        details,
        createdAt: new Date(),
        resolve,
        timeoutHandle,
      };

      this.pending.set(requestId, pending);
    });
  }

  /**
   * Handle user response to a permission request.
   * Returns true if the message was handled as a permission response.
   */
  handleUserResponse(agentId: string, message: string): boolean {
    const trimmed = message.trim().toLowerCase();

    // Try to parse response with optional request ID
    // Formats: "yes", "no", "a1b2 yes", "a1b2 no"
    const match = trimmed.match(/^(?:([a-f0-9]{4})\s+)?(yes|y|ok|approve|allow|no|n|deny|reject)$/);

    if (!match) {
      return false; // Not a permission response
    }

    const requestId = match[1];
    const response = match[2];

    // Determine approval
    const approved = ['yes', 'y', 'ok', 'approve', 'allow'].includes(response);

    // Find the pending request
    let pending: PendingPermission | undefined;

    if (requestId) {
      // Specific request ID provided
      pending = this.pending.get(requestId);
      if (!pending || pending.agentId !== agentId) {
        logger.warn('Permission response for unknown or mismatched request', {
          agentId,
          requestId,
        });
        return true; // Still counts as a permission response, just invalid
      }
    } else {
      // No request ID - find oldest pending for this agent
      pending = this.findOldestPending(agentId);
      if (!pending) {
        logger.warn('Permission response with no pending requests', { agentId });
        return true; // Still counts as a permission response, just invalid
      }
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeoutHandle);
    this.pending.delete(pending.id);

    // Log the decision
    if (approved) {
      logger.permissionGranted(agentId, pending.action, pending.details as object | undefined);
    } else {
      logger.permissionDenied(agentId, pending.action, 'user denied');
    }

    // Resolve the promise
    pending.resolve({ approved });

    return true;
  }

  /**
   * Get all pending permissions for an agent
   */
  getPending(agentId: string): PendingPermission[] {
    return Array.from(this.pending.values()).filter((p) => p.agentId === agentId);
  }

  /**
   * Cancel all pending permissions for an agent
   */
  cancelAll(agentId: string): void {
    const toCancel = this.getPending(agentId);

    for (const pending of toCancel) {
      clearTimeout(pending.timeoutHandle);
      this.pending.delete(pending.id);
      logger.info('Permission request cancelled', {
        agentId,
        requestId: pending.id,
        action: pending.action,
      });
      pending.resolve({
        approved: false,
        reason: 'cancelled',
      });
    }
  }

  /**
   * Generate a unique 4-character hex request ID
   */
  private generateRequestId(): string {
    const maxAttempts = 100;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Generate 4 random hex characters
      const id = Math.floor(Math.random() * 0x10000)
        .toString(16)
        .padStart(4, '0');

      if (!this.pending.has(id)) {
        return id;
      }
    }

    // Fallback to timestamp-based ID if collision
    return Date.now().toString(16).slice(-4);
  }

  /**
   * Find the oldest pending request for an agent
   */
  private findOldestPending(agentId: string): PendingPermission | undefined {
    const agentPending = this.getPending(agentId);

    if (agentPending.length === 0) {
      return undefined;
    }

    // Sort by creation time and return the oldest
    return agentPending.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  }

  /**
   * Format a permission request message for the user
   */
  private formatPermissionMessage(
    requestId: string,
    action: string,
    description: string,
    details?: unknown
  ): string {
    let message = `🔐 Permission #${requestId}\n`;
    message += `Action: ${this.formatActionName(action)}\n`;
    message += `${description}\n`;

    // Add relevant details based on tool input
    if (details && typeof details === 'object') {
      const input = details as Record<string, unknown>;

      if (input.command) {
        message += `Command: ${input.command}\n`;
      }
      if (input.file_path || input.file || input.path) {
        message += `File: ${input.file_path || input.file || input.path}\n`;
      }
      if (input.url) {
        message += `URL: ${input.url}\n`;
      }
      if (input.pattern) {
        message += `Pattern: ${input.pattern}\n`;
      }
      if (input.query) {
        message += `Query: ${input.query}\n`;
      }
    }

    message += `\nReply: yes / no`;

    return message;
  }

  /**
   * Format action name for display
   */
  private formatActionName(action: string): string {
    if (!action) {
      return 'Unknown Action';
    }
    // Convert snake_case or kebab-case to Title Case
    return action
      .replace(/[_-]/g, ' ')
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
