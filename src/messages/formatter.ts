import type { PermissionRequest, AgentStatusInfo } from './structured';

/**
 * Format a permission prompt for display to user.
 * Keep it scannable and mobile-friendly.
 */
export function formatPermissionPrompt(request: PermissionRequest, id: string): string {
  let message = `Permission #${id}:\n`;
  message += `  Action: ${request.action}\n`;
  message += `  ${request.description}\n`;

  if (request.details) {
    for (const [key, value] of Object.entries(request.details)) {
      const displayValue = typeof value === 'string' ? value : JSON.stringify(value);
      // Truncate long values
      const truncated = displayValue.length > 100
        ? displayValue.slice(0, 100) + '...'
        : displayValue;
      message += `  ${key}: ${truncated}\n`;
    }
  }

  message += `Reply: yes/no (or '${id} yes')`;
  return message;
}

/**
 * Format agent status for display.
 */
export function formatStatus(agent: AgentStatusInfo): string {
  return [
    `Agent: ${agent.id}`,
    `Type: ${agent.type}`,
    `Status: ${agent.status}`,
    `Work Dir: ${agent.workDir}`,
    `Created: ${agent.createdAt}`,
  ].join('\n');
}

/**
 * Format an error message for display.
 */
export function formatError(error: Error | string): string {
  const message = error instanceof Error ? error.message : error;
  return `Error: ${message}`;
}

/**
 * Format agent help text.
 */
export function formatAgentHelp(): string {
  return [
    'Agent Commands:',
    '  quit/exit - Shut down this agent',
    '  status    - Show agent status',
    '  help/?    - Show this help',
    '',
    'For permission prompts:',
    '  yes/y/1   - Approve',
    '  no/n/0    - Deny',
  ].join('\n');
}
