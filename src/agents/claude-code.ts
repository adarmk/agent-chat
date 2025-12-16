/**
 * Claude Code Agent Adapter
 *
 * Spawns and manages Claude Code CLI processes in headless mode.
 * Handles JSONL-based I/O streaming and structured message handling.
 */

import type { Subprocess } from 'bun';
import { AgentAdapter, AgentConfig, AgentProcess, OutputChunk } from './adapter';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Claude Code input message format (stdin JSONL)
 */
interface ClaudeCodeInput {
  type: 'user';
  message: {
    role: 'user';
    content: Array<{ type: 'text'; text: string }>;
  };
}

/**
 * Claude Code output event types (stdout JSONL)
 */
type ClaudeCodeEvent =
  | {
      type: 'init';
      session_id: string;
      assistant_mode: string;
    }
  | {
      type: 'assistant';
      message: {
        role: 'assistant';
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: unknown }
        >;
      };
    }
  | {
      type: 'result';
      session_id: string;
      stop_reason: string;
    };

/**
 * Implementation of AgentProcess for Claude Code
 */
class ClaudeCodeProcess implements AgentProcess {
  private proc: Subprocess;
  private _sessionId?: string;
  private messageQueue: string[] = [];
  private isReady: boolean = true;
  private exitCallback?: (exitCode: number | null) => void;

  constructor(proc: Subprocess) {
    this.proc = proc;

    // Monitor process exit
    this.monitorExit();
  }

  /**
   * Monitor process exit and call callback when it exits
   */
  private async monitorExit(): Promise<void> {
    try {
      await this.proc.exited;
      const exitCode = this.proc.exitCode;

      if (this.exitCallback) {
        this.exitCallback(exitCode);
      }
    } catch (err) {
      console.error('[ClaudeCodeProcess] Error monitoring exit:', err);
      if (this.exitCallback) {
        this.exitCallback(null);
      }
    }
  }

  /**
   * Send a message to Claude Code via stdin
   */
  send(message: string): void {
    if (!this.isAlive) {
      throw new Error('Cannot send message to terminated process');
    }

    // Queue messages if we're waiting for a response
    if (!this.isReady) {
      this.messageQueue.push(message);
      return;
    }

    this.writeMessage(message);
  }

  /**
   * Write a message to stdin in JSONL format
   */
  private writeMessage(text: string): void {
    const input: ClaudeCodeInput = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    };

    this.proc.stdin.write(JSON.stringify(input) + '\n');
    this.isReady = false;
  }

  /**
   * Process the next queued message
   */
  private processQueue(): void {
    const next = this.messageQueue.shift();
    if (next) {
      this.writeMessage(next);
    } else {
      this.isReady = true;
    }
  }

  /**
   * Async iterable that yields output chunks from Claude Code
   */
  get output(): AsyncIterable<OutputChunk> {
    return this.createOutputIterator();
  }

  /**
   * Create async generator for output chunks
   */
  private async *createOutputIterator(): AsyncIterable<OutputChunk> {
    if (!this.proc.stdout) {
      throw new Error('Process stdout not available');
    }

    // Read stdout line by line (JSONL format)
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

        // Process all complete lines, keep the last incomplete one in buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line) as ClaudeCodeEvent;

            // Handle different event types
            switch (event.type) {
              case 'init':
                this._sessionId = event.session_id;
                yield {
                  type: 'structured',
                  data: {
                    type: 'session_started',
                    sessionId: event.session_id,
                    assistantMode: event.assistant_mode,
                  },
                };
                break;

              case 'assistant':
                // Extract text content from assistant message
                for (const content of event.message.content) {
                  if (content.type === 'text') {
                    yield {
                      type: 'text',
                      content: content.text,
                    };
                  } else if (content.type === 'tool_use') {
                    yield {
                      type: 'structured',
                      data: {
                        type: 'tool_use',
                        id: content.id,
                        name: content.name,
                        input: content.input,
                      },
                    };
                  }
                }
                break;

              case 'result':
                this._sessionId = event.session_id;
                yield {
                  type: 'structured',
                  data: {
                    type: 'turn_complete',
                    sessionId: event.session_id,
                    stopReason: event.stop_reason,
                  },
                };

                // Process next queued message after turn completes
                this.processQueue();
                break;
            }
          } catch (err) {
            // Log parse errors but continue processing
            console.error('Failed to parse Claude Code output:', err, 'Line:', line);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Kill the Claude Code process
   */
  async kill(): Promise<void> {
    if (this.isAlive) {
      this.proc.kill();
      await this.proc.exited;
    }
  }

  /**
   * Check if the process is still running
   */
  get isAlive(): boolean {
    return !this.proc.killed && this.proc.exitCode === null;
  }

  /**
   * Get the session ID for resume capability
   */
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /**
   * Register a callback for when the process exits
   */
  onExit(callback: (exitCode: number | null) => void): void {
    this.exitCallback = callback;
  }
}

/**
 * Claude Code Agent Adapter
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly type = 'claude-code';
  readonly displayName = 'Claude Code';

  /**
   * Spawn a new Claude Code process
   */
  async spawn(config: AgentConfig): Promise<AgentProcess> {
    // Generate MCP config for this agent
    const mcpConfigPath = await this.generateMcpConfig(config);

    // Build Claude Code command arguments
    const args = [
      'claude',
      '-p', // Headless mode
      '--verbose', // Required when using --output-format=stream-json with --print
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--permission-prompt-tool',
      'mcp__agent_chat__permission_prompt',
      '--mcp-config',
      mcpConfigPath,
    ];

    // Add resume session if provided
    if (config.resumeSessionId) {
      args.push('--resume', config.resumeSessionId);
    }

    // Spawn the process
    const proc = Bun.spawn(args, {
      cwd: config.workDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        // Ensure Claude Code runs in headless mode
        CLAUDE_HEADLESS: '1',
      },
    });

    // Log stderr for debugging
    if (proc.stderr) {
      this.logStderr(proc.stderr, config.agentId);
    }

    const claudeProcess = new ClaudeCodeProcess(proc);

    // Send initial prompt via stdin (stream-json format requires stdin input)
    if (config.initialPrompt && !config.resumeSessionId) {
      claudeProcess.send(config.initialPrompt);
    }

    return claudeProcess;
  }

  /**
   * Generate MCP config file for this agent
   */
  private async generateMcpConfig(config: AgentConfig): Promise<string> {
    const mcpConfig = {
      mcpServers: {
        agent_chat: {
          type: 'http',
          url: config.mcpServerUrl,
          headers: {
            'X-Agent-ID': config.agentId,
          },
        },
      },
    };

    // Create /tmp directory if it doesn't exist (unlikely but safe)
    const tmpDir = '/tmp';
    await mkdir(tmpDir, { recursive: true });

    // Write config to /tmp
    const configPath = join(tmpDir, `agent-chat-${config.agentId}-mcp.json`);
    await writeFile(configPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');

    return configPath;
  }

  /**
   * Log stderr output for debugging
   */
  private async logStderr(stderr: ReadableStream, agentId: string): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          console.error(`[Claude Code ${agentId}] stderr:`, text);
        }
      }
    } catch (err) {
      console.error(`[Claude Code ${agentId}] stderr error:`, err);
    } finally {
      reader.releaseLock();
    }
  }
}
