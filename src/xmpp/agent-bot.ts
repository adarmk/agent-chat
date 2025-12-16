import type { XMPPClient } from './client';
import type { AgentProcess, OutputChunk } from '../agents/adapter';
import type { Agent } from '../state/persistence';
import type { AgentRegistry } from '../agents/registry';
import { logger } from '../utils/logger';
import { formatAgentHelp, formatStatus, formatError } from '../messages/formatter';
import type { AgentStatusInfo } from '../messages/structured';

const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB
const MAX_MESSAGES_PER_SECOND = 10;
const RATE_LIMIT_WINDOW_MS = 1000;

export interface AgentXMPPHandlerConfig {
  agent: Agent;
  agentProcess: AgentProcess;
  xmppClient: XMPPClient;
  registry: AgentRegistry;
  userJid: string;
}

export interface AgentStoppedEvent {
  agentId: string;
  reason: 'user_quit' | 'process_exit' | 'error';
}

/**
 * Handles XMPP message bridging for a single agent.
 *
 * Responsibilities:
 * - Bridge XMPP messages to/from agent process stdin/stdout
 * - Handle reserved commands (quit, status, help)
 * - Rate limit outgoing messages to prevent flooding
 * - Split large messages to stay within XMPP limits
 * - Emit events when agent stops
 */
export class AgentXMPPHandler {
  private config: AgentXMPPHandlerConfig;
  private stoppedCallback?: (event: AgentStoppedEvent) => void;
  private isRunning = false;
  private outputLoopPromise?: Promise<void>;

  // Rate limiting
  private messageTimestamps: number[] = [];
  private messageQueue: string[] = [];
  private isProcessingQueue = false;

  constructor(config: AgentXMPPHandlerConfig) {
    this.config = config;
  }

  /**
   * Start handling messages and output streaming.
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('AgentXMPPHandler already started', { agentId: this.config.agent.id });
      return;
    }

    this.isRunning = true;
    logger.info('Starting agent XMPP handler', {
      agentId: this.config.agent.id,
      userJid: this.config.userJid,
    });

    // Set up XMPP message handler
    this.config.xmppClient.onMessage((from: string, body: string) => {
      this.handleIncomingMessage(from, body);
    });

    // Start processing agent output
    this.outputLoopPromise = this.processAgentOutput();

    // Send greeting message to user so they can easily find this chat
    this.sendGreeting();
  }

  /**
   * Send initial greeting to user so they can find this agent in their XMPP client.
   */
  private async sendGreeting(): Promise<void> {
    try {
      const greeting = `Hi! I'm your coding agent (${this.config.agent.id}), working in ${this.config.agent.workDir}. I'm processing your request now...`;
      await this.config.xmppClient.sendMessage(this.config.userJid, greeting);
    } catch (error) {
      logger.error('Failed to send agent greeting', {
        agentId: this.config.agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Stop and cleanup.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping agent XMPP handler', { agentId: this.config.agent.id });
    this.isRunning = false;

    // Wait for output loop to finish
    if (this.outputLoopPromise) {
      await this.outputLoopPromise;
    }

    // Disconnect XMPP client
    await this.config.xmppClient.disconnect();
  }

  /**
   * Register callback for when agent stops.
   */
  onStopped(callback: (event: AgentStoppedEvent) => void): void {
    this.stoppedCallback = callback;
  }

  /**
   * Handle incoming XMPP message from user.
   */
  private handleIncomingMessage(from: string, body: string): void {
    // Only accept messages from the intended user
    // Strip resource from JID for comparison (user@domain/resource -> user@domain)
    const fromBare = from.split('/')[0];
    const userBare = this.config.userJid.split('/')[0];

    if (fromBare !== userBare) {
      logger.warn('Ignoring message from unexpected sender', {
        agentId: this.config.agent.id,
        from: fromBare,
        expected: userBare,
      });
      return;
    }

    const trimmed = body.trim();
    const lowerCased = trimmed.toLowerCase();

    // Handle reserved commands
    if (lowerCased === 'quit' || lowerCased === 'exit') {
      this.handleQuitCommand();
      return;
    }

    if (lowerCased === 'status') {
      this.handleStatusCommand();
      return;
    }

    if (lowerCased === 'help' || lowerCased === '?') {
      this.handleHelpCommand();
      return;
    }

    // Forward message to agent process
    try {
      logger.debug('Forwarding message to agent', {
        agentId: this.config.agent.id,
        messageLength: trimmed.length,
      });
      this.config.agentProcess.send(trimmed);
    } catch (error) {
      logger.error('Failed to send message to agent process', {
        agentId: this.config.agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sendToUser(formatError('Failed to send message to agent'));
    }
  }

  /**
   * Handle 'quit' or 'exit' command.
   */
  private async handleQuitCommand(): Promise<void> {
    logger.info('User requested agent shutdown', { agentId: this.config.agent.id });

    // Send shutdown message to user
    await this.sendToUser('Shutting down...');

    // Update registry status
    try {
      await this.config.registry.update(this.config.agent.id, {
        status: 'stopping',
      });
    } catch (error) {
      logger.error('Failed to update agent status', {
        agentId: this.config.agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Kill the agent process
    try {
      await this.config.agentProcess.kill();
    } catch (error) {
      logger.error('Failed to kill agent process', {
        agentId: this.config.agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Emit stopped event
    this.emitStopped('user_quit');
  }

  /**
   * Handle 'status' command.
   */
  private handleStatusCommand(): void {
    const statusInfo: AgentStatusInfo = {
      id: this.config.agent.id,
      type: this.config.agent.type,
      status: this.config.agent.status,
      workDir: this.config.agent.workDir,
      createdAt: this.config.agent.createdAt,
    };

    const message = formatStatus(statusInfo);
    this.sendToUser(message);
  }

  /**
   * Handle 'help' command.
   */
  private handleHelpCommand(): void {
    const message = formatAgentHelp();
    this.sendToUser(message);
  }

  /**
   * Process agent output and forward to user via XMPP.
   */
  private async processAgentOutput(): Promise<void> {
    try {
      let hasSeenOutput = false;

      for await (const chunk of this.config.agentProcess.output) {
        if (!this.isRunning) {
          logger.debug('Output loop stopping', { agentId: this.config.agent.id });
          break;
        }

        // Send typing indicator on first output
        if (!hasSeenOutput) {
          hasSeenOutput = true;
          this.config.xmppClient.sendTypingIndicator(this.config.userJid);
        }

        this.handleOutputChunk(chunk);
      }

      // Agent process has exited
      logger.info('Agent process output stream ended', { agentId: this.config.agent.id });

      if (this.isRunning) {
        this.emitStopped('process_exit');
      }
    } catch (error) {
      logger.error('Error processing agent output', {
        agentId: this.config.agent.id,
        error: error instanceof Error ? error.message : String(error),
      });

      if (this.isRunning) {
        this.sendToUser(formatError('Agent encountered an error'));
        this.emitStopped('error');
      }
    }
  }

  /**
   * Handle a single output chunk from the agent.
   */
  private handleOutputChunk(chunk: OutputChunk): void {
    if (chunk.type === 'text') {
      // Forward text content to user
      this.sendToUser(chunk.content);
    } else if (chunk.type === 'structured') {
      // Log structured data but don't send to user
      logger.debug('Received structured output from agent', {
        agentId: this.config.agent.id,
        dataType: chunk.data.type,
      });
    }
  }

  /**
   * Send a message to the user, with rate limiting and message splitting.
   */
  private sendToUser(content: string): void {
    if (!content.trim()) {
      return;
    }

    // Split message if it exceeds max size
    const chunks = this.splitMessage(content);

    for (const chunk of chunks) {
      this.messageQueue.push(chunk);
    }

    // Start processing queue if not already running
    if (!this.isProcessingQueue) {
      this.processMessageQueue();
    }
  }

  /**
   * Split a large message into chunks that fit within size limit.
   */
  private splitMessage(content: string): string[] {
    if (content.length <= MAX_MESSAGE_SIZE) {
      return [content];
    }

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      // Try to split at a newline near the limit
      let splitIndex = MAX_MESSAGE_SIZE;

      if (remaining.length > MAX_MESSAGE_SIZE) {
        const lastNewline = remaining.lastIndexOf('\n', MAX_MESSAGE_SIZE);
        if (lastNewline > MAX_MESSAGE_SIZE * 0.5) {
          // Only split at newline if it's reasonably close to the limit
          splitIndex = lastNewline + 1;
        }
      } else {
        splitIndex = remaining.length;
      }

      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex);
    }

    return chunks;
  }

  /**
   * Process queued messages with rate limiting.
   */
  private async processMessageQueue(): Promise<void> {
    if (this.isProcessingQueue) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0 && this.isRunning) {
      // Check rate limit
      const now = Date.now();

      // Remove timestamps outside the window
      this.messageTimestamps = this.messageTimestamps.filter(
        ts => now - ts < RATE_LIMIT_WINDOW_MS
      );

      // If at rate limit, wait before sending
      if (this.messageTimestamps.length >= MAX_MESSAGES_PER_SECOND) {
        const oldestTimestamp = this.messageTimestamps[0];
        const waitTime = RATE_LIMIT_WINDOW_MS - (now - oldestTimestamp);

        if (waitTime > 0) {
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue; // Re-check rate limit
        }
      }

      // Send next message
      const message = this.messageQueue.shift();
      if (message) {
        try {
          await this.config.xmppClient.sendMessage(this.config.userJid, message);
          this.messageTimestamps.push(Date.now());
        } catch (error) {
          logger.error('Failed to send message to user', {
            agentId: this.config.agent.id,
            error: error instanceof Error ? error.message : String(error),
          });
          // Re-queue the message
          this.messageQueue.unshift(message);
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Emit stopped event and cleanup.
   */
  private emitStopped(reason: AgentStoppedEvent['reason']): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    const event: AgentStoppedEvent = {
      agentId: this.config.agent.id,
      reason,
    };

    logger.info('Agent stopped', event);

    if (this.stoppedCallback) {
      this.stoppedCallback(event);
    }
  }
}
