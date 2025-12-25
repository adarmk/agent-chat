# Hot-Reload agent-chat Service

This skill explains how to hot-reload the agent-chat service running on this VPS.

## Service Location

- **tmux session**: `agent-chat`
- **working directory**: `/root/repos/agent-chat`
- **process**: `node dist/index.js` (started via `npm run start`)

## Hot-Reload Command

When the user asks to hot-reload the agent-chat service, run this command:

```bash
tmux send-keys -t agent-chat C-c && sleep 1 && tmux send-keys -t agent-chat 'npm run build && npm run start' Enter
```

This command:
1. Sends `Ctrl+C` to the tmux session to kill the currently running node process
2. Waits 1 second for graceful shutdown
3. Sends the rebuild (`npm run build`) and restart (`npm run start`) commands

## Verifying the Reload

After running the hot-reload command, verify it worked:

```bash
tmux capture-pane -t agent-chat -p | tail -20
```

This captures the last 20 lines of output from the tmux session without attaching to it.

Look for output indicating the service started successfully (e.g., connection messages, "listening" logs).

## Troubleshooting

If the session has multiple windows, target a specific window:

```bash
# List windows in the session
tmux list-windows -t agent-chat

# Target a specific window (e.g., window 0)
tmux send-keys -t agent-chat:0 C-c && sleep 1 && tmux send-keys -t agent-chat:0 'npm run build && npm run start' Enter
```

If the process doesn't stop with Ctrl+C, force kill it:

```bash
tmux send-keys -t agent-chat C-c C-c && sleep 2 && tmux send-keys -t agent-chat 'npm run build && npm run start' Enter
```

## Important

- Use `tmux send-keys` - do NOT attach to the session interactively
- The build uses esbuild and is fast
- The start script sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for TLS handling
