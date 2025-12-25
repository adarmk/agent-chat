import { XMPPClient } from './client';
import { XMPPAdmin } from './admin';
import { AgentRegistry } from '../agents/registry';
import { ClaudeCodeAdapter } from '../agents/claude-code';
import { Config } from '../config';
import { Agent } from '../state/persistence';
import { AgentConfig } from '../agents/adapter';
import logger from '../utils/logger';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Event emitted when a new agent is created
 */
export interface AgentCreatedEvent {
  agent: Agent;
  initialPrompt: string;
}

/**
 * Conversation state for multi-step agent creation flow
 */
interface ConversationState {
  step: 'idle' | 'awaiting_type' | 'awaiting_repo' | 'awaiting_task';
  agentType?: string;
  repo?: string;
}

/**
 * Manager Bot - handles agent lifecycle for XMPP Agent Chat Service
 *
 * Provides conversational interface for:
 * - Creating new agents (multi-step flow)
 * - Listing active agents
 * - Getting agent status
 * - Killing agents
 * - Listing available repositories
 */
export class ManagerBot {
  private config: Config;
  private registry: AgentRegistry;
  private xmppAdmin: XMPPAdmin;
  private client: XMPPClient;
  private adapter: ClaudeCodeAdapter;

  // Conversation state per user JID
  private conversations = new Map<string, ConversationState>();

  // Agent creation event callbacks
  private agentCreatedCallbacks: Array<(event: AgentCreatedEvent) => void> = [];

  constructor(
    config: Config,
    registry: AgentRegistry,
    xmppAdmin: XMPPAdmin
  ) {
    this.config = config;
    this.registry = registry;
    this.xmppAdmin = xmppAdmin;
    this.adapter = new ClaudeCodeAdapter();

    // Initialize XMPP client as manager@domain
    this.client = new XMPPClient({
      host: config.xmpp.host,
      port: config.xmpp.port,
      domain: config.xmpp.domain,
      username: config.manager.username,
      password: config.manager.password,
    });
  }

  /**
   * Start the manager bot - connects to XMPP and begins handling messages
   */
  async start(): Promise<void> {
    logger.info('Starting Manager Bot', {
      username: this.config.manager.username,
      domain: this.config.xmpp.domain,
    });

    // Connect to XMPP server
    await this.client.connect();

    // Register message handler
    this.client.onMessage((from, body) => {
      this.handleMessage(from, body).catch(err => {
        logger.error('Error handling message in manager bot', {
          from,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    logger.info('Manager Bot started');
  }

  /**
   * Stop the manager bot - disconnects from XMPP
   */
  async stop(): Promise<void> {
    logger.info('Stopping Manager Bot');
    await this.client.disconnect();
    logger.info('Manager Bot stopped');
  }

  /**
   * Register a callback for agent creation events
   */
  onAgentCreated(callback: (event: AgentCreatedEvent) => void): void {
    this.agentCreatedCallbacks.push(callback);
  }

  /**
   * Notify manager bot that an agent has stopped
   */
  notifyAgentStopped(agentId: string): void {
    logger.info('Manager Bot notified of agent stop', { agentId });
    // Could potentially notify users here, or clean up state
    // For now, just log it - the registry already handles the state update
  }

  /**
   * Handle incoming messages from users
   */
  private async handleMessage(from: string, body: string): Promise<void> {
    const command = body.trim().toLowerCase();
    const userJid = this.extractJid(from);

    logger.info('Manager Bot received message', { from: userJid, command });

    // Get or create conversation state for this user
    let state = this.conversations.get(userJid);
    if (!state) {
      state = { step: 'idle' };
      this.conversations.set(userJid, state);
    }

    // Handle commands or conversation flow
    if (state.step === 'idle') {
      await this.handleCommand(userJid, command);
    } else {
      await this.handleConversationStep(userJid, body.trim(), state);
    }
  }

  /**
   * Handle commands when not in a conversation flow
   */
  private async handleCommand(userJid: string, command: string): Promise<void> {
    // Agent creation commands
    if (command === 'new' || command === 'new agent' || command === 'create') {
      await this.startAgentCreation(userJid);
      return;
    }

    // List agents
    if (command === 'list' || command === 'agents') {
      await this.listAgents(userJid);
      return;
    }

    // Kill agent
    if (command.startsWith('kill ')) {
      const agentId = command.substring(5).trim();
      await this.killAgent(userJid, agentId);
      return;
    }

    // Kill all agents
    if (command === 'kill-all' || command === 'killall') {
      await this.killAllAgents(userJid);
      return;
    }

    // Status
    if (command.startsWith('status ')) {
      const agentId = command.substring(7).trim();
      await this.getAgentStatus(userJid, agentId);
      return;
    }

    // List repos
    if (command === 'repos') {
      await this.listRepos(userJid);
      return;
    }

    // Help
    if (command === 'help' || command === '?') {
      await this.showHelp(userJid);
      return;
    }

    // Unknown command
    await this.sendMessage(userJid,
      `Unknown command. Type 'help' to see available commands.`
    );
  }

  /**
   * Handle conversation steps for agent creation flow
   */
  private async handleConversationStep(
    userJid: string,
    input: string,
    state: ConversationState
  ): Promise<void> {
    switch (state.step) {
      case 'awaiting_type':
        await this.handleTypeSelection(userJid, input, state);
        break;

      case 'awaiting_repo':
        await this.handleRepoSelection(userJid, input, state);
        break;

      case 'awaiting_task':
        await this.handleTaskInput(userJid, input, state);
        break;
    }
  }

  /**
   * Start agent creation flow
   */
  private async startAgentCreation(userJid: string): Promise<void> {
    const state = this.conversations.get(userJid)!;
    state.step = 'awaiting_type';

    await this.sendMessage(userJid,
      `What type of agent?\n[1] Claude Code`
    );
  }

  /**
   * Handle agent type selection
   */
  private async handleTypeSelection(
    userJid: string,
    input: string,
    state: ConversationState
  ): Promise<void> {
    if (input === '1' || input.toLowerCase().includes('claude')) {
      state.agentType = 'claude-code';
      state.step = 'awaiting_repo';

      // List available repos
      const repos = await this.getAvailableRepos();

      if (repos.length === 0) {
        await this.sendMessage(userJid,
          `No repositories found in ${this.config.work.basePath}. Please add some repositories first.`
        );
        state.step = 'idle';
        return;
      }

      const repoList = repos
        .map((repo, idx) => `[${idx + 1}] ${repo}`)
        .join('\n');

      await this.sendMessage(userJid,
        `Available repos:\n${repoList}\n\nSelect a number or type a repo name:`
      );
    } else {
      await this.sendMessage(userJid,
        `Invalid selection. Please enter '1' for Claude Code or type 'cancel' to abort.`
      );
    }
  }

  /**
   * Handle repository selection
   */
  private async handleRepoSelection(
    userJid: string,
    input: string,
    state: ConversationState
  ): Promise<void> {
    if (input.toLowerCase() === 'cancel') {
      state.step = 'idle';
      await this.sendMessage(userJid, 'Agent creation cancelled.');
      return;
    }

    const repos = await this.getAvailableRepos();
    let selectedRepo: string | null = null;

    // Check if input is a number
    const selection = parseInt(input);
    if (!isNaN(selection) && selection >= 1 && selection <= repos.length) {
      selectedRepo = repos[selection - 1];
    } else {
      // Check if input matches a repo name
      selectedRepo = repos.find(r => r.toLowerCase() === input.toLowerCase()) || null;
    }

    if (selectedRepo) {
      state.repo = selectedRepo;
      state.step = 'awaiting_task';

      await this.sendMessage(userJid,
        `Great! What's the initial task for the agent?`
      );
    } else {
      await this.sendMessage(userJid,
        `Invalid selection. Please enter a number from the list or type 'cancel' to abort.`
      );
    }
  }

  /**
   * Handle initial task input and complete agent creation
   */
  private async handleTaskInput(
    userJid: string,
    input: string,
    state: ConversationState
  ): Promise<void> {
    if (input.toLowerCase() === 'cancel') {
      state.step = 'idle';
      await this.sendMessage(userJid, 'Agent creation cancelled.');
      return;
    }

    // Create the agent
    try {
      const initialPrompt = input;
      const workDir = join(this.config.work.basePath, state.repo!);

      // Generate agent ID
      const agentId = this.registry.generateId();
      const agentJid = `${agentId}@${this.config.xmpp.domain}`;

      // Generate password and create XMPP user
      const password = XMPPAdmin.generatePassword();
      await this.xmppAdmin.createUser(agentId, password);

      // Register agent in registry
      const agent = await this.registry.register({
        type: 'claude-code',
        jid: agentJid,
        workDir,
        createdBy: userJid,
        status: 'starting',
      });

      logger.info('Agent registered', {
        agentId: agent.id,
        jid: agent.jid,
        workDir,
      });

      // Reset conversation state
      state.step = 'idle';
      state.agentType = undefined;
      state.repo = undefined;

      // Notify user
      await this.sendMessage(userJid,
        `Agent ${agent.id} created. Chat at ${agent.jid}`
      );

      // Emit agent created event
      this.emitAgentCreated({ agent, initialPrompt });

    } catch (error) {
      logger.error('Failed to create agent', {
        error: error instanceof Error ? error.message : String(error),
      });

      await this.sendMessage(userJid,
        `Failed to create agent: ${error instanceof Error ? error.message : 'Unknown error'}`
      );

      // Reset state
      state.step = 'idle';
      state.agentType = undefined;
      state.repo = undefined;
    }
  }

  /**
   * List all active agents
   */
  private async listAgents(userJid: string): Promise<void> {
    const agents = this.registry.getAll();

    if (agents.length === 0) {
      await this.sendMessage(userJid, 'No agents currently active.');
      return;
    }

    const agentList = agents
      .map(agent => {
        const repoName = agent.workDir.split('/').pop() || 'unknown';
        return `${agent.id} - ${agent.status} - ${repoName} (${agent.jid})`;
      })
      .join('\n');

    await this.sendMessage(userJid,
      `Active agents:\n${agentList}`
    );
  }

  /**
   * Kill an agent
   */
  private async killAgent(userJid: string, agentId: string): Promise<void> {
    const agent = this.registry.get(agentId);

    if (!agent) {
      await this.sendMessage(userJid, `Agent not found: ${agentId}`);
      return;
    }

    try {
      // Update status to stopping
      await this.registry.update(agentId, { status: 'stopping' });

      // Kill process if it has a PID
      if (agent.pid) {
        try {
          process.kill(agent.pid, 'SIGTERM');
          logger.info('Sent SIGTERM to agent process', { agentId, pid: agent.pid });
        } catch (error) {
          logger.warn('Failed to kill agent process', {
            agentId,
            pid: agent.pid,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Delete XMPP user
      const username = agent.jid.split('@')[0];
      await this.xmppAdmin.deleteUser(username);

      // Remove from registry
      await this.registry.remove(agentId);

      await this.sendMessage(userJid, `Agent ${agentId} killed and removed.`);

      logger.info('Agent killed', { agentId });

    } catch (error) {
      logger.error('Failed to kill agent', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });

      await this.sendMessage(userJid,
        `Failed to kill agent: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Kill all agents
   */
  private async killAllAgents(userJid: string): Promise<void> {
    const agents = this.registry.getAll();

    if (agents.length === 0) {
      await this.sendMessage(userJid, 'No agents to kill.');
      return;
    }

    const killPromises = agents.map(agent => {
      return this.killAgent(userJid, agent.id);
    });

    try {
      await Promise.all(killPromises);
      await this.sendMessage(userJid, 'All agents killed.');
    } catch (error) {
      logger.error('Failed to kill agents', {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.sendMessage(userJid,
        `Failed to kill agents: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get status of a specific agent
   */
  private async getAgentStatus(userJid: string, agentId: string): Promise<void> {
    const agent = this.registry.get(agentId);

    if (!agent) {
      await this.sendMessage(userJid, `Agent not found: ${agentId}`);
      return;
    }

    const repoName = agent.workDir.split('/').pop() || 'unknown';
    const createdAt = new Date(agent.createdAt).toLocaleString();

    const status = [
      `Agent: ${agent.id}`,
      `Status: ${agent.status}`,
      `Type: ${agent.type}`,
      `Repository: ${repoName}`,
      `JID: ${agent.jid}`,
      `Created: ${createdAt}`,
      `Created by: ${agent.createdBy}`,
    ];

    if (agent.pid) {
      status.push(`PID: ${agent.pid}`);
    }

    if (agent.sessionId) {
      status.push(`Session ID: ${agent.sessionId}`);
    }

    await this.sendMessage(userJid, status.join('\n'));
  }

  /**
   * List available repositories
   */
  private async listRepos(userJid: string): Promise<void> {
    const repos = await this.getAvailableRepos();

    if (repos.length === 0) {
      await this.sendMessage(userJid,
        `No repositories found in ${this.config.work.basePath}`
      );
      return;
    }

    const repoList = repos
      .map((repo, idx) => `[${idx + 1}] ${repo}`)
      .join('\n');

    await this.sendMessage(userJid,
      `Available repositories:\n${repoList}`
    );
  }

  /**
   * Show help message with available commands
   */
  private async showHelp(userJid: string): Promise<void> {
    const helpText = [
      'Manager Bot Commands:',
      '',
      'new / create - Start agent creation flow',
      'list / agents - List all active agents',
      'kill <agent-id> - Force-kill an agent',
      'kill-all - Force-kill all active agents',
      'status <agent-id> - Get agent status',
      'repos - List available repositories',
      'help - Show this help message',
    ].join('\n');

    await this.sendMessage(userJid, helpText);
  }

  /**
   * Get available repositories from work base path
   */
  private async getAvailableRepos(): Promise<string[]> {
    try {
      const entries = readdirSync(this.config.work.basePath, { withFileTypes: true });
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
    } catch (error) {
      logger.error('Failed to read work base path', {
        path: this.config.work.basePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Send a message to a user
   */
  private async sendMessage(to: string, body: string): Promise<void> {
    try {
      await this.client.sendMessage(to, body);
    } catch (error) {
      logger.error('Failed to send message', {
        to,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Extract bare JID from full JID (remove resource)
   */
  private extractJid(fullJid: string): string {
    return fullJid.split('/')[0];
  }

  /**
   * Emit agent created event to all registered callbacks
   */
  private emitAgentCreated(event: AgentCreatedEvent): void {
    for (const callback of this.agentCreatedCallbacks) {
      try {
        callback(event);
      } catch (error) {
        logger.error('Error in agent created callback', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
