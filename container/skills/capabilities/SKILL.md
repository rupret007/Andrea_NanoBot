---
name: capabilities
description: Show what this NanoClaw instance can do - installed skills, available tools, runtime details, and system info. Read-only. Use when the user asks what the bot can do, what's installed, or runs /capabilities.
---

# /capabilities - System Capabilities Report

Generate a structured read-only report of what this NanoClaw instance can do.

**Main-channel check:** Only the main channel has `/workspace/project` mounted. Run:

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If `NOT_MAIN`, respond with:

> This command is available in your main chat only. Send `/capabilities` there to see what I can do.

Then stop - do not generate the report.

## How to gather the information

Run these commands and compile the results into the report format below.

### 1. Installed skills

List skill directories available to you:

```bash
ls -1 /home/node/.claude/skills/ 2>/dev/null || echo "No skills found"
```

Each directory is an installed skill. The directory name is the skill name.

### 2. Available tools

Read the allowed tools from your SDK configuration. You always have access to:

- **Core:** Bash, Read, Write, Edit, Glob, Grep
- **Web:** WebSearch, WebFetch
- **Orchestration:** Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage
- **Other:** TodoWrite, ToolSearch, Skill, NotebookEdit
- **MCP:** `mcp__nanoclaw__*` (messaging, tasks, group management, community skills)

### 3. MCP server tools

The NanoClaw MCP server exposes these tools (via `mcp__nanoclaw__*` prefix):

- `send_message` - send a message to the user/group
- `schedule_task` - schedule a recurring or one-time task
- `list_tasks` - list scheduled tasks
- `pause_task` - pause a scheduled task
- `resume_task` - resume a paused task
- `cancel_task` - cancel and delete a task
- `update_task` - update an existing task
- `register_group` - register a new chat/group (main only)
- `search_openclaw_skills` - search the bundled community OpenClaw skill catalog
- `enable_openclaw_skill` - enable a chosen community skill for this chat
- `disable_openclaw_skill` - disable a previously enabled community skill for this chat
- `list_enabled_openclaw_skills` - list the community skills currently enabled for this chat
- `install_openclaw_skill` - compatibility alias for `enable_openclaw_skill`

### 4. Container skills and runtime

Check for executable tools in the container:

```bash
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not found"
echo "Runtime: ${NANOCLAW_CONTAINER_RUNTIME:-unknown}"
```

### 5. Group info

```bash
ls /workspace/group/CLAUDE.md 2>/dev/null && echo "Group memory: yes" || echo "Group memory: no"
ls /workspace/extra/ 2>/dev/null && echo "Extra mounts: $(ls /workspace/extra/ 2>/dev/null | wc -l | tr -d ' ')" || echo "Extra mounts: none"
```

## Report format

Present the report as a clean, readable message. Example:

```text
NanoClaw Capabilities

Installed Skills:
- /agent-browser - Browse the web, fill forms, extract data
- /capabilities - This report

Tools:
- Core: Bash, Read, Write, Edit, Glob, Grep
- Web: WebSearch, WebFetch
- Orchestration: Task, TeamCreate, SendMessage
- MCP: send_message, schedule_task, list_tasks, pause/resume/cancel/update_task, register_group, search_openclaw_skills, enable/disable/list_enabled_openclaw_skills, install_openclaw_skill

Container Tools:
- agent-browser: available
- Runtime: podman

System:
- Group memory: yes
- Extra mounts: 0
- Main channel: yes
```

Adapt the output based on what you actually find - do not list things that are not installed.

**See also:** `/status` for a quick health check of session, workspace, and tasks.
