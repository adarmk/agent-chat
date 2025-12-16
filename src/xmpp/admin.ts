// src/xmpp/admin.ts

import logger from '../utils/logger';

export interface XMPPAdminConfig {
  host: string;
  port: number;
  domain: string;
  adminUsername: string;
  adminPassword: string;
}

export class XMPPAdmin {
  private config: XMPPAdminConfig;
  private baseUrl: string;

  constructor(config: XMPPAdminConfig) {
    this.config = config;
    // mod_admin_rest typically runs on HTTP port 5280
    this.baseUrl = `http://${config.host}:5280`;
  }

  /**
   * Create a new XMPP user for an agent
   */
  async createUser(username: string, password: string): Promise<void> {
    const jid = `${username}@${this.config.domain}`;

    try {
      const response = await fetch(`${this.baseUrl}/admin/user/${encodeURIComponent(jid)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${btoa(`${this.config.adminUsername}:${this.config.adminPassword}`)}`,
        },
        body: JSON.stringify({ password }),
      });

      if (!response.ok && response.status !== 409) { // 409 = already exists
        const errorText = await response.text();
        throw new Error(`Failed to create user: ${response.status} ${response.statusText} - ${errorText}`);
      }

      if (response.status === 409) {
        logger.info(`XMPP user already exists: ${jid}`);
      } else {
        logger.info(`Created XMPP user: ${jid}`);
      }
    } catch (error) {
      logger.error(`Failed to create XMPP user ${jid}`, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Delete an XMPP user when agent is destroyed
   */
  async deleteUser(username: string): Promise<void> {
    const jid = `${username}@${this.config.domain}`;

    try {
      const response = await fetch(`${this.baseUrl}/admin/user/${encodeURIComponent(jid)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Basic ${btoa(`${this.config.adminUsername}:${this.config.adminPassword}`)}`,
        },
      });

      if (!response.ok && response.status !== 404) { // 404 = already gone
        const errorText = await response.text();
        throw new Error(`Failed to delete user: ${response.status} ${response.statusText} - ${errorText}`);
      }

      if (response.status === 404) {
        logger.info(`XMPP user already deleted: ${jid}`);
      } else {
        logger.info(`Deleted XMPP user: ${jid}`);
      }
    } catch (error) {
      logger.error(`Failed to delete XMPP user ${jid}`, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Generate a random password for an agent
   */
  static generatePassword(): string {
    // Generate 16-character random password
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }
}
