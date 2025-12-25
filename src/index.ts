/**
 * Agent Chat Service - Entry Point
 *
 * Main entry point that starts all services and orchestrates
 * agent lifecycle management.
 */

import { loadConfig, Config } from './config';
import { StatePersistence } from './state/persistence';
import { AgentRegistry } from './agents/registry';
import { ClaudeCodeAdapter } from './agents/claude-code';
import { AgentRecovery } from './agents/recovery';
import { XMPPClient } from './xmpp/client';
import { XMPPAdmin } from './xmpp/admin';
import { ManagerBot, AgentCreatedEvent } from './xmpp/manager-bot';
import { AgentXMPPHandler } from './xmpp/agent-bot';
import { MCPServer } from './mcp/server';
import { PermissionPromptTool } from './mcp/tools/permission-prompt';
import logger from './utils/logger';
import type { AgentProcess } from './agents/adapter';

// Active agent handlers map (agentId -> handler)
const agentHandlers = new Map<string, AgentXMPPHandler>();

// Service components (for graceful shutdown)
let config: Config;
let persistence: StatePersistence;
let registry: AgentRegistry;
let mcpServer: MCPServer;
let managerBot: ManagerBot;
let xmppAdmin: XMPPAdmin;
let adapter: ClaudeCodeAdapter;
let recovery: AgentRecovery;
let permissionTool: PermissionPromptTool;
let isShuttingDown = false;

/**
 * Main entry point
 */
async function main(): Promise<void> {
  logger.info('Agent Chat Service starting...');

  try {
    // 1. Load configuration
    config = await loadConfig();
    logger.info('Configuration loaded', {
      xmppDomain: config.xmpp.domain,
      mcpPort: config.mcp.port,
      workBasePath: config.work.basePath,
    });

    // 2. Initialize persistence and load state
    persistence = new StatePersistence();
    await persistence.load();
    logger.info('State loaded');

    // 3. Initialize agent registry
    registry = new AgentRegistry(persistence);
    await registry.load();
    logger.info('Agent registry initialized', {
      agentCount: registry.getAll().length,
    });

    // 4. Initialize agent adapter and recovery
    adapter = new ClaudeCodeAdapter();
    const mcpServerUrl = `http://localhost:${config.mcp.port}/mcp`;
    recovery = new AgentRecovery(adapter, registry, mcpServerUrl);

    // 5. Initialize XMPP admin
    xmppAdmin = new XMPPAdmin({
      host: config.xmpp.host,
      port: config.xmpp.port,
      domain: config.xmpp.domain,
      adminUsername: config.xmpp.adminUsername,
      adminPassword: config.xmpp.adminPassword,
    });

    // 6. Start MCP server
    mcpServer = new MCPServer();
    await mcpServer.start(config.mcp.port);
    logger.info('MCP server started', { port: config.mcp.port });

    // 7. Create and register permission prompt tool
    permissionTool = new PermissionPromptTool(
      registry,
      async (agentId: string, message: string) => {
        const handler = agentHandlers.get(agentId);
        if (handler) {
          // Use the agent's XMPP connection to send the permission request to user
          handler.sendToUser(message);
          logger.debug('Permission message sent for agent', { agentId });
        } else {
          logger.warn('No handler found for agent, cannot send permission message', { agentId });
        }
      },
      config.mcp.permissionTimeout
    );

    mcpServer.registerTool(
      'permission_prompt',
      permissionTool.getSchema(),
      permissionTool.getHandler()
    );
    logger.info('Permission prompt tool registered');

    // 8. Start manager bot
    managerBot = new ManagerBot(config, registry, xmppAdmin);

    // Handle agent creation events
    managerBot.onAgentCreated((event) => {
      handleAgentCreated(event).catch((error) => {
        logger.error('Failed to handle agent creation', {
          agentId: event.agent.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    await managerBot.start();
    logger.info('Manager bot started', {
      jid: `${config.manager.username}@${config.xmpp.domain}`,
    });

    // 9. Set up signal handlers for graceful shutdown
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    logger.info('Agent Chat Service started successfully');
    logger.info('Listening for messages...');

  } catch (error) {
    logger.error('Failed to start Agent Chat Service', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

/**
 * Handle agent creation event from manager bot
 */
async function handleAgentCreated(event: AgentCreatedEvent): Promise<void> {
  const { agent, initialPrompt, password } = event;
  logger.info('Handling agent creation', { agentId: agent.id });

  try {
    // Create XMPP client for the agent using password from manager bot
    const agentXmppClient = new XMPPClient({
      host: config.xmpp.host,
      port: config.xmpp.port,
      domain: config.xmpp.domain,
      username: agent.id,
      password,
    });

    // Connect agent's XMPP client
    await agentXmppClient.connect();
    logger.info('Agent XMPP client connected', { agentId: agent.id });

    // Spawn agent process
    const mcpServerUrl = `http://localhost:${config.mcp.port}/mcp`;
    const agentProcess = await adapter.spawn({
      workDir: agent.workDir,
      agentId: agent.id,
      mcpServerUrl,
      initialPrompt,
    });

    // Update agent status
    await registry.update(agent.id, { status: 'running' });

    // Create XMPP handler for the agent
    const handler = new AgentXMPPHandler({
      agent,
      agentProcess,
      xmppClient: agentXmppClient,
      registry,
      userJid: agent.createdBy,
      permissionTool,
    });

    // Handle agent stopped event
    handler.onStopped(async (stoppedEvent) => {
      logger.info('Agent stopped', stoppedEvent);

      // Clean up handler
      agentHandlers.delete(stoppedEvent.agentId);

      // Cancel pending permissions
      permissionTool.cancelAll(stoppedEvent.agentId);

      // Update registry
      await registry.update(stoppedEvent.agentId, { status: 'stopped' });

      // Notify manager bot
      managerBot.notifyAgentStopped(stoppedEvent.agentId);

      // Attempt recovery if process crashed
      if (stoppedEvent.reason === 'process_exit') {
        const currentAgent = registry.get(stoppedEvent.agentId);
        if (currentAgent) {
          const recoveryResult = await recovery.attemptAutoRecovery(currentAgent, null);
          if (recoveryResult?.success) {
            logger.info('Agent recovered successfully', {
              agentId: stoppedEvent.agentId,
              resumed: recoveryResult.resumed,
            });
          }
        }
      }
    });

    // Set up process exit handler
    agentProcess.onExit(async (exitCode) => {
      logger.info('Agent process exited', { agentId: agent.id, exitCode });

      // The handler's onStopped will be called via the output stream ending
      // If we need to handle early exit before output ends:
      if (exitCode !== 0 && exitCode !== null) {
        const currentAgent = registry.get(agent.id);
        if (currentAgent && currentAgent.status === 'running') {
          // Update session ID if available
          const sessionId = agentProcess.sessionId;
          if (sessionId) {
            await registry.update(agent.id, { sessionId });
          }
        }
      }
    });

    // Store handler
    agentHandlers.set(agent.id, handler);

    // Start handling messages
    handler.start();

    logger.info('Agent fully initialized', { agentId: agent.id });

  } catch (error) {
    logger.error('Failed to initialize agent', {
      agentId: agent.id,
      error: error instanceof Error ? error.message : String(error),
    });

    // Update status to stopped
    await registry.update(agent.id, { status: 'stopped' });

    throw error;
  }
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  logger.info(`Received ${signal}, starting graceful shutdown...`);

  try {
    // 1. Stop accepting new agents (manager bot will stop)
    if (managerBot) {
      logger.info('Stopping manager bot...');
      await managerBot.stop();
    }

    // 2. Stop all active agent handlers
    logger.info('Stopping agent handlers...', { count: agentHandlers.size });
    const stopPromises: Promise<void>[] = [];

    for (const [agentId, handler] of agentHandlers) {
      logger.info('Stopping agent handler', { agentId });
      stopPromises.push(handler.stop());
      permissionTool?.cancelAll(agentId);
    }

    await Promise.all(stopPromises);
    agentHandlers.clear();

    // 3. Stop MCP server
    if (mcpServer) {
      logger.info('Stopping MCP server...');
      await mcpServer.stop();
    }

    // 4. Mark all agents as stopped in persistence
    if (persistence) {
      logger.info('Saving final state...');
      await persistence.markAllStopped();
    }

    logger.info('Graceful shutdown complete');
    process.exit(0);

  } catch (error) {
    logger.error('Error during shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Start the service
main().catch((error) => {
  logger.error('Unhandled error in main', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
