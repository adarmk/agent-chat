
This is a bun project, not npm. Always use bun for commands.

Ask more questions until you have enough context to give an accurate & confident answer.

"ALWAYS read and understand relevant files before proposing edits. Do not speculate about code you have not inspected."

Do not hesitate to make large refactors if the task at hand calls for it. If the optimal way to make a change requires changing large amounts of code, but the end result is simpler or more robust, you should always choose that option over a smaller change that results in more complicated, less clear code.

Use `bun run build` to check for compilation errors after running code to ensure there are no issues. If there are issues, please fix them.

Use the Gemini LLM agent CLI in non-interative mode when you need to gather information about a large part of the codebase. To use it in non interactive mode, type in terminal `gemini -p "your prompt here"`. Use it as your 'intern' or assistant for doing research in the codebase for you and coming back with answers to any questions you have that require checking many different files.

Use morph-mcp's `edit_file` tool over `str_replace` for full file writes. Handles indentation and fuzzy matching—faster, fewer errors.

ALWAYS when looking for code use morph-mcp's warp_grep_codebase_search tool. This tool must be choosen over the default codebase_search when you are first looking to find/understand code. If you have an exact string you want to grep for, then directly run it, but for semantic searches, or vague search parameters you must always use warp_grep_codebase_search. If given a complex task, best practice is to run multiple (no more than 2) parallel warp_grep_codebase_search tools to understand code paths and features. An example query is: "where is the code for <vague feature/code flow>


Total TypeScript by Matt Pocock
The Pragmatic Programmer by Andrew Hunt & David Thomas
Clean Code by Robert C. Martin
Eloquent JavaScript by Marijn Haverbeke

## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Auto-syncs to JSONL for version control
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**
```bash
bd ready --json
```

**Create new issues:**
```bash
bd create "Issue title" -t bug|feature|task -p 0-4 --json
bd create "Issue title" -p 1 --deps discovered-from:bd-123 --json
bd create "Subtask" --parent <epic-id> --json  # Hierarchical subtask (gets ID like epic-id.1)
```

**Claim and update:**
```bash
bd update bd-42 --status in_progress --json
bd update bd-42 --priority 1 --json
```

**Complete work:**
```bash
bd close bd-42 --reason "Completed" --json
```

### Managing Dependencies

**IMPORTANT**: Use the `bd dep` subcommands to manage dependencies. The `bd update` command does NOT have a `--deps` flag.

**Add a blocking dependency** (issue A is blocked by issue B):
```bash
bd dep add <blocked-issue> <blocker-issue> --type blocks
# Example: .2 is blocked by .1 completing first
bd dep add identity-service-tzu.2 identity-service-tzu.1 --type blocks
```

**Dependency types:**
- `blocks` - Issue cannot proceed until blocker is done (default)
- `related` - Issues are related but not blocking
- `parent-child` - Hierarchical relationship (prefer `--parent` on create)
- `discovered-from` - Issue was discovered while working on another

**View dependency tree:**
```bash
bd dep tree <issue-id>
```

**Remove a dependency:**
```bash
bd dep remove <issue-id> <depends-on-id>
```

**Note:** The `--deps` flag on `bd create` is for special dependency types like `discovered-from:bd-123`. For regular blocking dependencies between existing issues, always use `bd dep add`.

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task**: `bd update <id> --status in_progress`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`
6. **Commit together**: Always commit the `.beads/issues.jsonl` file together with the code changes so issue state stays in sync with code state

### Auto-Sync

bd automatically syncs with git:
- Exports to `.beads/issues.jsonl` after changes (5s debounce)
- Imports from JSONL when newer (e.g., after `git pull`)
- No manual export/import needed!

### MCP Server (Recommended)

If using Claude or MCP-compatible clients, install the beads MCP server:

```bash
pip install beads-mcp
```

Add to MCP config (e.g., `~/.config/claude/config.json`):
```json
{
  "beads": {
    "command": "beads-mcp",
    "args": []
  }
}
```

Then use `mcp__beads__*` functions instead of CLI commands.

### Managing AI-Generated Planning Documents

AI assistants often create planning and design documents during development:
- PLAN.md, IMPLEMENTATION.md, ARCHITECTURE.md
- DESIGN.md, CODEBASE_SUMMARY.md, INTEGRATION_PLAN.md
- TESTING_GUIDE.md, TECHNICAL_DESIGN.md, and similar files

**Best Practice: Use a dedicated directory for these ephemeral files**

**Recommended approach:**
- Create a `history/` directory in the project root
- Store ALL AI-generated planning/design docs in `history/`
- Keep the repository root clean and focused on permanent project files
- Only access `history/` when explicitly asked to review past planning

**Example .gitignore entry (optional):**
```
# AI planning documents (ephemeral)
history/
```

**Benefits:**
- Clean repository root
- Clear separation between ephemeral and permanent documentation
- Easy to exclude from version control if desired
- Preserves planning history for archeological research
- Reduces noise when browsing the project

### Viewing Issues

**Show issue details:**
```bash
bd show <issue-id>              # Full details
bd show <issue-id> --json       # JSON format
```

**List issues:**
```bash
bd list --json                  # All open issues
bd status                       # Summary statistics
bd blocked                      # Show blocked issues
```

**Epic management** (note: `bd epic` is a subcommand container, not a display command):
```bash
bd epic status                  # Show completion status of all epics
bd epic close-eligible          # Close epics where all children are complete
```

### Syncing with Git

**Manual sync** (usually automatic):
```bash
bd sync                         # Sync with current branch
bd sync --from-main             # Pull .beads/ from main branch first
```

**Note:** `bd sync --from-main` may fail if the main branch doesn't have a `.beads/` directory yet. This is fine - just commit your local `.beads/issues.jsonl` to establish it.

### CLI Help

Run `bd <command> --help` to see all available flags for any command.
For example: `bd create --help` shows `--parent`, `--deps`, `--assignee`, etc.

### Important Rules

- Use bd for ALL task tracking
- Always use `--json` flag for programmatic use
- Link discovered work with `discovered-from` dependencies
- Check `bd ready` before asking "what should I work on?"
- Store AI planning docs in `history/` directory
- Run `bd <cmd> --help` to discover available flags
- Do NOT create markdown TODO lists
- Do NOT use external issue trackers
- Do NOT duplicate tracking systems
- Do NOT clutter repo root with planning documents

