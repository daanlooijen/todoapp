# Taskline

A local-first, AI-native task manager modelled on how Todoist works. It runs on your own machine (macOS or Windows), keeps your data in a SQLite file you own, and is built so that Claude can manage it directly.

## Quick start

Requires [Node.js](https://nodejs.org) 22.13 or newer (nothing else, no compiler, no database server).

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
# put your ANTHROPIC_API_KEY in .env to enable the AI features (optional)
npm start
```

Open http://localhost:4100.

## How Todoist works, and how Taskline maps it

Todoist's public API documents its whole model. Taskline keeps the parts that matter and adds an AI layer:

| Todoist concept | Taskline |
|---|---|
| Inbox, projects, sub-projects, sections | Same. Projects are archived, never hard-deleted |
| Tasks, subtasks (any depth), descriptions, comments | Same |
| Priorities p1 to p4 | Same, stored as 1 (urgent) to 4 (none). Note: Todoist's API stores these inverted |
| Labels (`@label`) | Same, created on first use |
| Natural-language due dates and recurring tasks | Same idea: "tomorrow 5pm", "every weekday", "every! 3 days" (from completion), "every month on 15" |
| Completing a recurring task moves it to the next date | Same, overdue ones skip ahead past today |
| Quick add: `Call mom fri 5pm #Family @phone p2` | Same syntax, plus `// description` |
| Deadlines, duration estimates | Same |
| Sync API with incremental tokens | Not needed locally. An append-only activity log serves the same purpose |

What Taskline adds:

- **Smart add**: paste a brain dump, an email or meeting notes and Claude turns it into structured tasks. You review them before anything is saved.
- **Break down**: splits a task into concrete subtasks.
- **Plan my day**: proposes a realistic order for today and suggests what to move, based on your actual completion rate.
- **Memory**: facts about how you work ("deep work before noon") that every AI feature takes into account.
- **Activity log**: every change records who made it (you, the in-app AI, or Claude over MCP).
- **MCP server**: Claude Desktop or Claude Code can read and manage your tasks.

## Connect Claude (MCP)

The MCP server is a separate process that uses the same database, so it works whether or not the web app is running.

**Claude Code:**

```bash
claude mcp add taskline -- node /Users/daanlooijen/to-do/src/mcp.js
```

**Claude Desktop:** Settings, Developer, Edit Config, then add:

```json
{
  "mcpServers": {
    "taskline": {
      "command": "node",
      "args": ["/Users/daanlooijen/to-do/src/mcp.js"]
    }
  }
}
```

On Windows use the full path with escaped backslashes, e.g. `"C:\\Users\\you\\to-do\\src\\mcp.js"`.

Then ask things like "what's on my plate today?", "move everything from Work that's overdue to next week", or "remember that I don't take calls on Fridays". Changes show up in the open web app within a few seconds.

## Your data

- Stored in `~/Library/Application Support/Taskline` (macOS) or `%APPDATA%\Taskline` (Windows), outside the code folder, so deleting or re-cloning the code never touches it.
- A backup is taken at startup and every 24 hours to `backups/`, keeping the last 14. Set the SMTP settings in `.env` to get an email if a backup fails.
- Deleted tasks stay in Trash for 30 days.
- **Export JSON** in the sidebar downloads everything in a plain format any tool or AI can read.
- To restore a backup: stop Taskline, copy a file from `backups/` over `taskline.db`, and start it again.

## Security

- The server listens on `127.0.0.1` only. Other devices on your network can't reach it, which matters because there is no login.
- Requests with a foreign `Host` header are rejected (blocks DNS-rebinding attacks), and writes from other websites are blocked by an `Origin` check plus a JSON-only rule (blocks CSRF).
- A strict Content Security Policy, and the UI never inserts task text as HTML, so a malicious task title can't run code.
- Your API key stays in `.env` on the server side and is never sent to the browser.
- AI output is treated as untrusted: it is validated and clamped before saving, and capture and planning results are shown to you before they are applied.

## Keyboard shortcuts

`q` or `n` add task, `s` smart add, `/` search, `Esc` close.

## Development

```bash
npm run dev    # restart on file changes
npm test       # unit tests (in-memory database, never touches your data)
```

Code layout: `src/store.js` is the only module that writes data. The web API (`src/server.js`), the AI features (`src/ai.js`) and the MCP server (`src/mcp.js`) all go through it. `src/shared/` holds the date and quick-add parsers, which the browser imports too.
