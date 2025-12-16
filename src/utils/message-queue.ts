/**
 * Message Queue
 *
 * A reusable message queue with size and age limits.
 * Used to buffer messages during disconnections and ensure reliable delivery.
 */

interface QueuedMessage {
  to: string;
  message: string;
  timestamp: Date;
}

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private maxSize: number;
  private maxAgeMs: number;

  /**
   * Create a new message queue
   * @param maxSize Maximum number of messages to queue (default: 100)
   * @param maxAgeMs Maximum age of messages in milliseconds (default: 5 minutes)
   */
  constructor(maxSize: number = 100, maxAgeMs: number = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.maxAgeMs = maxAgeMs;
  }

  /**
   * Add a message to the queue.
   * Automatically prunes old messages if needed.
   * Drops oldest messages if queue exceeds maxSize.
   */
  enqueue(to: string, message: string): void {
    // Prune old messages first
    this.prune();

    // Add new message
    this.queue.push({
      to,
      message,
      timestamp: new Date(),
    });

    // If we exceed maxSize, remove oldest messages
    while (this.queue.length > this.maxSize) {
      this.queue.shift();
    }
  }

  /**
   * Flush all messages using the provided sender function.
   * Clears the queue after successful flush.
   * Re-queues failed messages.
   */
  async flush(sender: (to: string, msg: string) => Promise<void>): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }

    const messages = [...this.queue];
    this.queue = [];

    for (const { to, message } of messages) {
      try {
        await sender(to, message);
      } catch (err) {
        console.error('[MessageQueue] Failed to send message:', err);
        // Re-queue failed messages
        this.queue.push({ to, message, timestamp: new Date() });
      }
    }
  }

  /**
   * Remove messages older than maxAgeMs.
   * @returns Number of messages removed
   */
  prune(): number {
    const now = Date.now();
    const originalLength = this.queue.length;

    this.queue = this.queue.filter(msg => {
      const age = now - msg.timestamp.getTime();
      return age < this.maxAgeMs;
    });

    return originalLength - this.queue.length;
  }

  /**
   * Get the current number of messages in the queue
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Clear all messages from the queue
   */
  clear(): void {
    this.queue = [];
  }
}
