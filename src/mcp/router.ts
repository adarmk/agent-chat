import { PermissionRequest, PermissionResult } from '../messages/structured';

export interface AgentHandler {
  // Handle permission prompts for this agent
  handlePermission(request: PermissionRequest): Promise<PermissionResult>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export class MCPRouter {
  private handlers: Map<string, AgentHandler> = new Map();

  // Register a handler for an agent
  registerAgent(agentId: string, handler: AgentHandler): void {
    this.handlers.set(agentId, handler);
    console.log(`Registered handler for agent: ${agentId}`);
  }

  // Unregister when agent disconnects
  unregisterAgent(agentId: string): void {
    this.handlers.delete(agentId);
    console.log(`Unregistered handler for agent: ${agentId}`);
  }

  // Get handler for agent
  getHandler(agentId: string): AgentHandler | undefined {
    return this.handlers.get(agentId);
  }

  // Check if agent has a handler
  hasHandler(agentId: string): boolean {
    return this.handlers.has(agentId);
  }

  // Route a permission request to the appropriate agent
  async routePermission(agentId: string, request: PermissionRequest): Promise<PermissionResult> {
    const handler = this.handlers.get(agentId);
    if (!handler) {
      return {
        approved: false,
        reason: `No handler registered for agent: ${agentId}`,
      };
    }

    try {
      return await handler.handlePermission(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        approved: false,
        reason: `Error handling permission: ${message}`,
      };
    }
  }

  // Get list of registered agent IDs
  getRegisteredAgents(): string[] {
    return Array.from(this.handlers.keys());
  }
}
