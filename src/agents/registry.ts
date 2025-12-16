import { StatePersistence, Agent, AgentStatus, AgentType } from '../state/persistence';

const ADJECTIVES = [
  'swift', 'clever', 'bold', 'calm', 'eager',
  'gentle', 'happy', 'keen', 'lucky', 'mighty',
  'noble', 'quick', 'sharp', 'wise', 'brave',
  'bright', 'cool', 'fair', 'grand', 'jolly'
];

const ANIMALS = [
  'fox', 'owl', 'bear', 'wolf', 'hawk',
  'deer', 'lynx', 'seal', 'crow', 'dove',
  'hare', 'lion', 'otter', 'panda', 'raven',
  'tiger', 'viper', 'whale', 'zebra', 'badger'
];

/**
 * Manages the registry of active agents in memory.
 * Tracks all agents by ID and JID, generates unique agent identifiers,
 * and persists state changes to disk.
 */
export class AgentRegistry {
  private persistence: StatePersistence;
  private agents: Map<string, Agent> = new Map();

  constructor(persistence: StatePersistence) {
    this.persistence = persistence;
  }

  /**
   * Initialize the registry from persisted state.
   * Loads all agents from disk into the in-memory map.
   */
  async load(): Promise<void> {
    const state = await this.persistence.load();
    this.agents.clear();

    for (const agent of state.agents) {
      this.agents.set(agent.id, agent);
    }
  }

  /**
   * Get all agents in the registry.
   */
  getAll(): Agent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get an agent by its ID.
   */
  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  /**
   * Get an agent by its XMPP JID.
   */
  getByJid(jid: string): Agent | undefined {
    return Array.from(this.agents.values()).find(agent => agent.jid === jid);
  }

  /**
   * Register a new agent in the registry.
   * Generates a unique ID and sets the creation timestamp.
   * Persists the agent to disk.
   */
  async register(agent: Omit<Agent, 'id' | 'createdAt'>): Promise<Agent> {
    const id = this.generateId();
    const createdAt = new Date().toISOString();

    const newAgent: Agent = {
      ...agent,
      id,
      createdAt,
    };

    this.agents.set(id, newAgent);
    await this.persistence.upsertAgent(newAgent);

    return newAgent;
  }

  /**
   * Update an existing agent's properties.
   * Merges the updates with the existing agent data and persists.
   */
  async update(id: string, updates: Partial<Agent>): Promise<void> {
    const existing = this.agents.get(id);
    if (!existing) {
      throw new Error(`Agent not found: ${id}`);
    }

    const updated: Agent = {
      ...existing,
      ...updates,
      // Preserve immutable fields
      id: existing.id,
      createdAt: existing.createdAt,
    };

    this.agents.set(id, updated);
    await this.persistence.upsertAgent(updated);
  }

  /**
   * Remove an agent from the registry.
   * Deletes from both memory and disk.
   */
  async remove(id: string): Promise<void> {
    this.agents.delete(id);
    await this.persistence.removeAgent(id);
  }

  /**
   * Generate a unique agent ID in the format [adjective]-[animal].
   * Retries on collision up to 10 times.
   */
  generateId(): string {
    const maxAttempts = 10;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
      const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
      const id = `${adjective}-${animal}`;

      if (!this.agents.has(id)) {
        return id;
      }
    }

    throw new Error('Failed to generate unique agent ID after 10 attempts');
  }
}
