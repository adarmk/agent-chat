import { client, xml } from '@xmpp/client';

// Type for the XMPP client instance (no exported types from @xmpp/client)
type XMPPClientInstance = ReturnType<typeof client>;

export interface XMPPClientConfig {
  host: string;
  port: number;
  domain: string;
  username: string;
  password: string;
  tls?: boolean;  // Enable TLS/SSL connection
}

interface QueuedMessage {
  to: string;
  body: string;
}

export class XMPPClient {
  private config: XMPPClientConfig;
  private client: XMPPClientInstance | null = null;
  private _isConnected = false;
  private messageHandlers: Array<(from: string, body: string) => void> = [];
  private messageQueue: QueuedMessage[] = [];
  private reconnectAttempts = 0;
  private maxReconnectDelay = 60000; // 60 seconds
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  constructor(config: XMPPClientConfig) {
    this.config = config;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(): Promise<void> {
    if (this.client) {
      throw new Error('Client already exists. Call disconnect() first.');
    }

    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      // Use xmpps:// for TLS, xmpp:// for plain connections
      const protocol = this.config.tls ? 'xmpps' : 'xmpp';
      
      const xmppClient = client({
        service: `${protocol}://${this.config.host}:${this.config.port}`,
        domain: this.config.domain,
        username: this.config.username,
        password: this.config.password,
        tls: {
          rejectUnauthorized: false,  // Accept self-signed certificates
        },
      });

      this.client = xmppClient;

      // Handle connection success
      const onOnline = async (address: any) => {
        console.log(`[XMPP] Connected as ${address.toString()}`);
        this._isConnected = true;
        this.reconnectAttempts = 0;

        // Send initial presence
        await this.sendPresence();

        // Flush queued messages
        await this.flushMessageQueue();

        resolve();
      };

      // Handle incoming stanzas
      const onStanza = (stanza: any) => {
        // Only process message stanzas
        if (stanza.is('message')) {
          const type = stanza.attrs.type;
          const from = stanza.attrs.from;
          const body = stanza.getChildText('body');

          // Skip offline/delayed messages to prevent duplicate processing after reconnect
          // XEP-0203: Prosody adds <delay> element to messages stored while we were offline
          const delay = stanza.getChild('delay', 'urn:xmpp:delay');
          if (delay) {
            console.log('[XMPP] Ignoring offline message from:', from);
            return;
          }

          // Only handle chat messages with body content
          if ((type === 'chat' || !type) && body) {
            // Notify all message handlers
            this.messageHandlers.forEach(handler => {
              try {
                handler(from, body);
              } catch (error) {
                console.error('[XMPP] Error in message handler:', error);
              }
            });
          }
        }
      };

      // Handle errors
      const onError = (err: Error) => {
        console.error('[XMPP] Error:', err);
        // Don't reject here - we'll handle reconnection
      };

      // Handle disconnection
      const onOffline = () => {
        console.log('[XMPP] Disconnected');
        this._isConnected = false;

        // Auto-reconnect with exponential backoff if we should reconnect
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };

      // Attach event listeners
      xmppClient.on('online', onOnline);
      xmppClient.on('stanza', onStanza);
      xmppClient.on('error', onError);
      xmppClient.on('offline', onOffline);

      // Start connection
      xmppClient.start().catch((err) => {
        console.error('[XMPP] Failed to start:', err);
        reject(err);
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    // Calculate delay with exponential backoff: 1s, 2s, 4s, 8s, ..., max 60s
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    console.log(`[XMPP] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;

      try {
        // Clean up old client
        if (this.client) {
          this.client.removeAllListeners();
          await this.client.stop().catch(() => {});
          this.client = null;
        }

        // Attempt reconnection
        await this.connect();
      } catch (err) {
        console.error('[XMPP] Reconnection failed:', err);
        // scheduleReconnect will be called again via onOffline
      }
    }, delay);
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client) {
      try {
        // Send unavailable presence
        await this.sendPresence('unavailable');
        await this.client.stop();
      } catch (err) {
        console.error('[XMPP] Error during disconnect:', err);
      } finally {
        this.client = null;
        this._isConnected = false;
      }
    }
  }

  private async sendPresence(type?: string): Promise<void> {
    if (!this.client) {
      return;
    }

    const presence = type
      ? xml('presence', { type })
      : xml('presence');

    await this.client.send(presence);
  }

  async sendMessage(to: string, body: string): Promise<void> {
    // If not connected, queue the message
    if (!this._isConnected) {
      console.log('[XMPP] Not connected, queueing message');
      this.messageQueue.push({ to, body });
      return;
    }

    if (!this.client) {
      throw new Error('Client not initialized');
    }

    const message = xml(
      'message',
      { type: 'chat', to },
      xml('body', {}, body)
    );

    await this.client.send(message);
  }

  sendTypingIndicator(to: string): void {
    if (!this._isConnected || !this.client) {
      console.log('[XMPP] Not connected, cannot send typing indicator');
      return;
    }

    // XEP-0085: Chat State Notifications - composing state
    const message = xml(
      'message',
      { type: 'chat', to },
      xml('composing', { xmlns: 'http://jabber.org/protocol/chatstates' })
    );

    this.client.send(message).catch(err => {
      console.error('[XMPP] Failed to send typing indicator:', err);
    });
  }

  onMessage(handler: (from: string, body: string) => void): void {
    this.messageHandlers.push(handler);
  }

  private async flushMessageQueue(): Promise<void> {
    if (this.messageQueue.length === 0) {
      return;
    }

    console.log(`[XMPP] Flushing ${this.messageQueue.length} queued messages`);

    const messages = [...this.messageQueue];
    this.messageQueue = [];

    for (const { to, body } of messages) {
      try {
        await this.sendMessage(to, body);
      } catch (err) {
        console.error('[XMPP] Failed to send queued message:', err);
        // Re-queue failed messages
        this.messageQueue.push({ to, body });
      }
    }
  }
}
