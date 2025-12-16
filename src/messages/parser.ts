import type { PermissionResult } from './structured';

export type ParsedMessage =
  | { type: 'permission_response'; permissionId?: string; approved: boolean }
  | { type: 'command'; command: 'quit' | 'status' | 'help' }
  | { type: 'message'; content: string };

/**
 * Parse user input to detect permission responses, commands, or regular messages.
 *
 * Permission responses:
 * - 'yes', 'y', '1' → approved: true
 * - 'no', 'n', '0' → approved: false
 * - 'abc123 yes' → with permission ID
 *
 * Commands:
 * - 'quit', 'exit', '/quit' → quit
 * - 'status', '/status' → status
 * - 'help', '/help', '?' → help
 */
export function parseMessage(text: string): ParsedMessage {
  const trimmed = text.trim().toLowerCase();

  // Check for commands first
  if (['quit', 'exit', '/quit'].includes(trimmed)) {
    return { type: 'command', command: 'quit' };
  }
  if (['status', '/status'].includes(trimmed)) {
    return { type: 'command', command: 'status' };
  }
  if (['help', '/help', '?'].includes(trimmed)) {
    return { type: 'command', command: 'help' };
  }

  // Check for permission responses
  // Pattern: optional ID followed by yes/no
  const permissionMatch = trimmed.match(/^([a-z0-9]+\s+)?(yes|no|y|n|1|0)$/);
  if (permissionMatch) {
    const id = permissionMatch[1]?.trim();
    const response = permissionMatch[2];
    const approved = ['yes', 'y', '1'].includes(response);
    return { type: 'permission_response', permissionId: id, approved };
  }

  // Default: regular message
  return { type: 'message', content: text };
}
