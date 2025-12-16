import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Type definitions
export type AgentType = 'claude-code' | string;
export type AgentStatus = 'starting' | 'running' | 'stopping' | 'stopped';

export interface Agent {
  id: string;              // e.g., 'swift-fox'
  type: AgentType;         // 'claude-code' | ...
  jid: string;             // XMPP JID: 'swift-fox@domain'
  workDir: string;         // '/home/user/work/my-project'
  createdAt: string;       // ISO date string
  createdBy: string;       // Your JID
  status: AgentStatus;
  pid?: number;            // OS process ID
  sessionId?: string;      // Claude Code session ID (for --resume)
}

export interface ServiceState {
  agents: Agent[];
  config: {
    workBasePath: string;  // e.g., '/home/user/work'
    xmppDomain: string;
    managerJid: string;
  };
}

/**
 * Manages state persistence for the agent chat service.
 * State is stored in ~/.agent-chat/state.json
 */
export class StatePersistence {
  private statePath: string;
  private state: ServiceState;

  constructor() {
    this.statePath = `${process.env.HOME}/.agent-chat/state.json`;
    this.state = this.getEmptyState();
  }

  /**
   * Returns an empty initial state
   */
  private getEmptyState(): ServiceState {
    return {
      agents: [],
      config: {
        workBasePath: `${process.env.HOME}/work`,
        xmppDomain: 'localhost',
        managerJid: '',
      },
    };
  }

  /**
   * Load state from disk.
   * Returns empty state if the file doesn't exist or is corrupted.
   */
  async load(): Promise<ServiceState> {
    try {
      const file = Bun.file(this.statePath);

      if (await file.exists()) {
        const loadedState = await file.json();

        // Validate that the loaded state has the expected structure
        if (loadedState && typeof loadedState === 'object' && Array.isArray(loadedState.agents)) {
          this.state = loadedState;

          // Mark all agents as stopped on service restart
          await this.markAllStopped();

          return this.state;
        }
      }
    } catch (e) {
      // File doesn't exist, is corrupted, or can't be parsed
      console.warn(`Failed to load state from ${this.statePath}:`, e);
    }

    // Return empty state if anything went wrong
    this.state = this.getEmptyState();
    return this.state;
  }

  /**
   * Save current state to disk.
   * Creates the directory if it doesn't exist.
   */
  async save(): Promise<void> {
    try {
      // Ensure the directory exists
      const dir = dirname(this.statePath);
      await mkdir(dir, { recursive: true });

      // Write the state file with pretty formatting
      await Bun.write(
        this.statePath,
        JSON.stringify(this.state, null, 2)
      );
    } catch (e) {
      console.error(`Failed to save state to ${this.statePath}:`, e);
      throw e;
    }
  }

  /**
   * Get the current state (without loading from disk)
   */
  getState(): ServiceState {
    return this.state;
  }

  /**
   * Update the agents list and save to disk
   */
  async updateAgents(agents: Agent[]): Promise<void> {
    this.state.agents = agents;
    await this.save();
  }

  /**
   * Mark all agents as stopped.
   * This should be called when the service restarts to reflect
   * that all agents are no longer running.
   */
  async markAllStopped(): Promise<void> {
    this.state.agents = this.state.agents.map(agent => ({
      ...agent,
      status: 'stopped' as AgentStatus,
      pid: undefined, // Clear PID since process is no longer running
    }));

    // Save the updated state
    await this.save();
  }

  /**
   * Update the service configuration and save to disk
   */
  async updateConfig(config: Partial<ServiceState['config']>): Promise<void> {
    this.state.config = {
      ...this.state.config,
      ...config,
    };
    await this.save();
  }

  /**
   * Add or update a single agent
   */
  async upsertAgent(agent: Agent): Promise<void> {
    const existingIndex = this.state.agents.findIndex(a => a.id === agent.id);

    if (existingIndex >= 0) {
      this.state.agents[existingIndex] = agent;
    } else {
      this.state.agents.push(agent);
    }

    await this.save();
  }

  /**
   * Remove an agent by ID
   */
  async removeAgent(agentId: string): Promise<void> {
    this.state.agents = this.state.agents.filter(a => a.id !== agentId);
    await this.save();
  }

  /**
   * Get an agent by ID
   */
  getAgent(agentId: string): Agent | undefined {
    return this.state.agents.find(a => a.id === agentId);
  }

  /**
   * Get all agents with a specific status
   */
  getAgentsByStatus(status: AgentStatus): Agent[] {
    return this.state.agents.filter(a => a.status === status);
  }
}
