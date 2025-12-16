/**
 * Agent Recovery
 *
 * Utilities for recovering crashed agent processes.
 * Supports resuming sessions when possible, or starting fresh.
 */

import { ClaudeCodeAdapter } from './claude-code';
import { AgentRegistry } from './registry';
import { Agent } from '../state/persistence';
import type { AgentProcess } from './adapter';

export interface RecoveryResult {
  success: boolean;
  resumed: boolean;      // true if resumed with session, false if fresh start
  process?: AgentProcess;
  error?: string;
}

/**
 * Agent Recovery Manager
 *
 * Handles recovery of crashed agent processes with session resume support.
 */
export class AgentRecovery {
  constructor(
    private adapter: ClaudeCodeAdapter,
    private registry: AgentRegistry,
    private mcpServerUrl: string
  ) {}

  /**
   * Attempt to recover an agent that crashed.
   *
   * Recovery strategy:
   * 1. Check if agent has a sessionId (can resume)
   * 2. If yes: spawn with --resume flag
   * 3. If no: start fresh session
   * 4. Update registry with new status and PID
   *
   * @param agent The agent to recover
   * @returns Recovery result with new process if successful
   */
  async recover(agent: Agent): Promise<RecoveryResult> {
    try {
      console.log(`[AgentRecovery] Attempting to recover agent ${agent.id}`);

      // Update status to starting
      await this.registry.update(agent.id, { status: 'starting' });

      // Determine if we can resume or need to start fresh
      const canResume = !!agent.sessionId;

      // Build agent config
      const config = {
        workDir: agent.workDir,
        agentId: agent.id,
        mcpServerUrl: this.mcpServerUrl,
        resumeSessionId: canResume ? agent.sessionId : undefined,
      };

      // Spawn the process
      const process = await this.adapter.spawn(config);

      // Update registry with new status
      await this.registry.update(agent.id, {
        status: 'running',
        // Note: PID is not available in Bun's Subprocess type
        // We could store process reference if needed
      });

      console.log(
        `[AgentRecovery] Successfully recovered agent ${agent.id} (${
          canResume ? 'resumed session' : 'fresh start'
        })`
      );

      return {
        success: true,
        resumed: canResume,
        process,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[AgentRecovery] Failed to recover agent ${agent.id}:`, errorMessage);

      // Update status to stopped
      await this.registry.update(agent.id, { status: 'stopped' });

      return {
        success: false,
        resumed: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle unexpected process exit.
   * Analyzes exit code and determines if recovery should be attempted.
   *
   * @param agent The agent that exited
   * @param exitCode Process exit code (null if killed)
   * @returns Decision on whether to recover and reason
   */
  handleProcessExit(
    agent: Agent,
    exitCode: number | null
  ): {
    shouldRecover: boolean;
    reason: string;
  } {
    // Log the exit
    if (exitCode === null) {
      console.log(`[AgentRecovery] Agent ${agent.id} was killed`);
      return {
        shouldRecover: false,
        reason: 'Process was killed intentionally',
      };
    }

    if (exitCode === 0) {
      console.log(`[AgentRecovery] Agent ${agent.id} exited normally`);
      return {
        shouldRecover: false,
        reason: 'Process exited normally',
      };
    }

    // Non-zero exit codes indicate crashes
    console.log(`[AgentRecovery] Agent ${agent.id} crashed with exit code ${exitCode}`);

    // Determine if we should recover based on exit code
    // Common exit codes:
    // 1 - General error
    // 2 - Misuse of shell command
    // 126 - Command cannot execute
    // 127 - Command not found
    // 130 - SIGINT (Ctrl+C)
    // 137 - SIGKILL
    // 143 - SIGTERM

    // Don't recover if the process was terminated by signal
    if (exitCode >= 128) {
      return {
        shouldRecover: false,
        reason: `Process terminated by signal (exit code ${exitCode})`,
      };
    }

    // Don't recover if command not found (likely installation issue)
    if (exitCode === 127) {
      return {
        shouldRecover: false,
        reason: 'Command not found - check Claude Code installation',
      };
    }

    // Recover for general errors
    return {
      shouldRecover: true,
      reason: `Process crashed with exit code ${exitCode}`,
    };
  }

  /**
   * Attempt automatic recovery for an agent.
   * Combines handleProcessExit decision with recover execution.
   *
   * @param agent The agent that exited
   * @param exitCode Process exit code
   * @returns Recovery result if recovery was attempted, undefined if not
   */
  async attemptAutoRecovery(
    agent: Agent,
    exitCode: number | null
  ): Promise<RecoveryResult | undefined> {
    const decision = this.handleProcessExit(agent, exitCode);

    if (!decision.shouldRecover) {
      console.log(`[AgentRecovery] Not recovering agent ${agent.id}: ${decision.reason}`);
      // Update status to stopped
      await this.registry.update(agent.id, { status: 'stopped' });
      return undefined;
    }

    console.log(`[AgentRecovery] Auto-recovering agent ${agent.id}: ${decision.reason}`);
    return await this.recover(agent);
  }
}
