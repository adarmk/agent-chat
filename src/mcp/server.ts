import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Handler function for tool calls
 * @param args - Tool arguments from the client
 * @param agentId - ID of the agent making the call
 * @returns Tool execution result
 */
export type ToolHandler = (args: Record<string, unknown>, agentId: string) => Promise<unknown>;

interface RegisteredTool {
  schema: Tool;
  handler: ToolHandler;
}

interface ConnectionInfo {
  agentId: string;
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  connectedAt: Date;
}

/**
 * MCP HTTP Server that provides tools to Claude Code agents via SSE transport.
 * Runs a single HTTP server that all agents connect to.
 */
export class MCPServer {
  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private tools: Map<string, RegisteredTool> = new Map();
  private connections: Map<string, ConnectionInfo> = new Map();
  private port: number = 3001;

  constructor() {}

  /**
   * Start the HTTP server on the specified port
   */
  async start(port: number = 3001): Promise<void> {
    this.port = port;

    this.httpServer = Bun.serve({
      port: this.port,
      fetch: (req) => this.handleRequest(req),
    });

    console.log(`MCP Server started on http://localhost:${this.port}`);
  }

  /**
   * Stop the HTTP server and clean up all connections
   */
  async stop(): Promise<void> {
    if (!this.httpServer) {
      return;
    }

    // Close all active connections
    for (const [agentId, conn] of this.connections.entries()) {
      try {
        await conn.transport.close();
        console.log(`Closed connection for agent: ${agentId}`);
      } catch (error) {
        console.error(`Error closing connection for ${agentId}:`, error);
      }
    }
    this.connections.clear();

    // Stop the HTTP server
    this.httpServer.stop();
    this.httpServer = null;

    console.log('MCP Server stopped');
  }

  /**
   * Register a tool that agents can call
   * @param name - Tool name
   * @param schema - Tool schema (JSON Schema)
   * @param handler - Function to execute when tool is called
   */
  registerTool(name: string, schema: Tool, handler: ToolHandler): void {
    this.tools.set(name, { schema, handler });
    console.log(`Registered tool: ${name}`);
  }

  /**
   * Check if an agent is currently connected
   */
  isAgentConnected(agentId: string): boolean {
    return this.connections.has(agentId);
  }

  /**
   * Get list of connected agent IDs
   */
  getConnectedAgents(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Only handle /mcp endpoint
    if (url.pathname !== '/mcp') {
      return new Response('Not Found', { status: 404 });
    }

    // Extract agent ID from header
    const agentId = req.headers.get('X-Agent-ID');
    if (!agentId) {
      return new Response('Missing X-Agent-ID header', { status: 400 });
    }

    // Get or create connection for this agent
    let connection = this.connections.get(agentId);

    // For GET requests (SSE stream) or if no connection exists, create new transport
    if (!connection || req.method === 'GET') {
      connection = await this.createConnection(agentId);
    }

    // Let the transport handle the request
    try {
      return await connection.transport.handleRequest(req);
    } catch (error) {
      console.error(`Error handling request for agent ${agentId}:`, error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  /**
   * Create a new connection for an agent
   */
  private async createConnection(agentId: string): Promise<ConnectionInfo> {
    // Create transport with session management
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: async (sessionId) => {
        console.log(`Session initialized for agent ${agentId}: ${sessionId}`);
      },
      onsessionclosed: async (sessionId) => {
        console.log(`Session closed for agent ${agentId}: ${sessionId}`);
        this.connections.delete(agentId);
      },
    });

    // Create MCP server instance for this connection
    const server = new Server(
      {
        name: 'agent-chat-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Set up tool handlers
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: Array.from(this.tools.values()).map((t) => t.schema),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;

      const tool = this.tools.get(name);
      if (!tool) {
        return {
          content: [
            {
              type: 'text',
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await tool.handler(args ?? {}, agentId);
        return {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Error executing tool ${name}: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });

    // Set up transport error handlers
    transport.onerror = (error) => {
      console.error(`Transport error for agent ${agentId}:`, error);
    };

    transport.onclose = () => {
      console.log(`Transport closed for agent ${agentId}`);
      this.connections.delete(agentId);
    };

    // Connect server to transport
    await server.connect(transport);

    const connection: ConnectionInfo = {
      agentId,
      transport,
      server,
      connectedAt: new Date(),
    };

    this.connections.set(agentId, connection);
    console.log(`Agent connected: ${agentId}`);

    return connection;
  }
}
