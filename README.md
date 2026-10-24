# Taskline

**A local-first, AI-native task manager.** Inspired by how Todoist works, rebuilt from scratch to run on your own machine, keep your data in a file you own, and let Claude manage your tasks directly.

- Runs on **macOS and Windows** (and Linux) with nothing but Node.js
- Your tasks live in a **SQLite file on your computer**, with automatic daily backups
- **Claude can read and manage your tasks** through a built-in [MCP](https://modelcontextprotocol.io) server
- Optional **AI features** in the app: turn messy notes into tasks, break tasks down, plan your day

> Taskline is an independent project. It is not affiliated with or endorsed by Doist or Todoist.

## Features

**Everything you expect from a task manager**

- Inbox, projects, sections, and subtasks at any depth
- Priorities (P1 to P4), labels, comments, deadlines, and time estimates
- Due dates in plain English: `tomorrow 5pm`, `next friday`, `in 2 weeks`, `3 nov`
- Repeating tasks: `every weekday`, `every mon,thu`, `every month on 15`, `every! 3 days` (counts from when you finish it)
- Today, Upcoming, Completed, search, and a 30-day trash
- Live preview while you type, so you see exactly how a task will be saved
- Light and dark mode, works on phone-sized screens

**Built for AI**

- **MCP server**: ask Claude "what's on my plate today?" or "move everything overdue to next week", and it acts on your real tasks
- **Smart add**: paste a brain dump, an email, or meeting notes, and get structured tasks back. You review them before anything is saved
- **Break down**: split a vague task into concrete next steps
- **Plan my day**: get a realistic order for today and suggestions for what to move, based on how much you actually get done
- **Memory**: tell it how you work ("deep work before noon", "no calls on Fridays") and every AI feature takes that into account
- **Activity log**: every change records who made it: you, the in-app AI, or Claude

## Quick start

You need [Node.js](https://nodejs.org) 22.13 or newer, on a release line that still gets security updates (22, 24 or 26; the odd-numbered lines like 25 are short-lived). The installer from nodejs.org is the easiest way to get it. Nothing else: no database server, no compiler.

```bash
git clone https://github.com/daanlooijen/todoapp.git
cd todoapp
npm install
npm start
```

Open **http://localhost:4100** and start adding tasks.

The task manager works fully without an API key. To turn on the in-app AI features, see [Configuration](#configuration).

## Quick-add syntax

Type everything on one line and Taskline sorts it out:

```
Call mom friday 5pm #Family @phone p2 // ask about the weekend
```

| You type | It sets |
|---|---|
| `tomorrow`, `fri`, `next week`, `in 3 days`, `24 dec`, `2026-12-24` | Due date |
| `5pm`, `17:00`, `at 9:30am` | Due time |
| `every day`, `every weekday`, `every mon,wed`, `every month on 1` | Repeat rule |
| `every! 2 weeks` | Repeat, counting from when you complete it |
| `#Project` (use `_` for spaces: `#Side_project`) | Project (must already exist) |
| `@label` | Label (created if new) |
| `p1` to `p4` | Priority (p1 is most urgent) |
| `// some text` | Description |

Keyboard shortcuts: `q` or `n` add a task, `s` smart add, `/` search, `Esc` close.

## Connect Claude (MCP)

The MCP server runs as its own process and shares the same database, so it works whether or not the web app is open. Replace `/path/to/todoapp` with where you cloned the repo.

**Claude Code**

```bash
claude mcp add taskline -s user -- node /path/to/todoapp/src/mcp.js
```

Then start a new Claude Code session and run `/mcp` to check that it's connected.

**Claude Desktop**: open Settings, then Developer, then Edit Config, and add:

```json
{
  "mcpServers": {
    "taskline": {
      "command": "node",
      "args": ["/path/to/todoapp/src/mcp.js"]
    }
  }
}
```

On Windows, use a full path with escaped backslashes, for example `"C:\\Users\\you\\todoapp\\src\\mcp.js"`.

**Things to try**

- "What's on my plate today?"
- "Add: dentist next Tuesday 10am, renew passport before March, and gym every mon, wed, fri at 7"
- "Everything overdue in Work can move to next week"
- "Remember that I don't take calls on Fridays"

Changes Claude makes appear in the open web app within a few seconds.

## Configuration

Copy the example file and edit it:

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

| Setting | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on Smart add, Break down, and Plan my day. Get a key at [console.anthropic.com](https://console.anthropic.com) |
| `TASKLINE_AI_MODEL` | Claude model for the in-app AI (default `claude-opus-5-5`) |
| `PORT` | Web app port (default `4100`) |
| `TASKLINE_DATA_DIR` | Where your data is stored (see below) |
| `TASKLINE_BACKUP_KEEP` | Number of daily backups to keep (default `14`) |
| `SMTP_*`, `ALERT_EMAIL_TO` | Email you if a scheduled backup fails |

`.env` is git-ignored, so your keys never end up in the repository. Restart Taskline after changing it.

The MCP server doesn't need an API key: when you use Claude through MCP, Claude does the thinking.

## Your data

| | |
|---|---|
| **Where** | `~/Library/Application Support/Taskline` (macOS), `%APPDATA%\Taskline` (Windows), `~/.local/share/taskline` (Linux) |
| **Backups** | At startup and every 24 hours, in the `backups/` folder |
| **Restore a backup** | Stop Taskline, copy a file from `backups/` over `taskline.db`, start it again |
| **Export** | "Export JSON" in the sidebar downloads everything in a plain, readable format |
| **Deleted tasks** | Kept in Trash for 30 days |

Data lives outside the code folder on purpose: deleting, updating, or re-cloning the code never touches your tasks.

## Security

Taskline has no login, so it's built to be reachable only from your own computer:

- **Local only**: the server listens on `127.0.0.1`, so other devices on your network can't connect.
- **No hijacking by websites**: requests with an unexpected `Host` header are rejected (this blocks DNS rebinding), and a site you visit can't send writes to Taskline (an `Origin` check plus JSON-only requests block cross-site request forgery).
- **No script injection**: task text is always displayed as plain text, and a strict Content Security Policy blocks any script that doesn't come from Taskline itself.
- **Keys stay on the server**: your API key is read from `.env` by the server and never sent to the browser.
- **AI output is checked**: everything the AI suggests is validated before it's saved, and Smart add and Plan my day show you their proposals first.
- **Private data folder**: on macOS and Linux the data folder is readable by your user account only.

One limit to know: other programs running under your own account can reach `localhost:4100` too, just like any local app without a login. Don't run Taskline on a shared or untrusted computer.

Found a security issue? Please open a GitHub issue without exploit details and I'll get in touch.

## How it's built

```
src/
  server.js        Web server and REST API (Express)
  store.js         The only module that writes data: validation and activity log live here
  db.js            SQLite schema and migrations (Node's built-in node:sqlite)
  ai.js            Smart add, Break down, Plan my day (Claude API with structured outputs)
  mcp.js           MCP server for Claude Desktop and Claude Code
  backup.js        Daily backups and failure emails
  shared/          Date and quick-add parsers, used by both the server and the browser
public/            The web app: plain HTML, CSS, and JavaScript, no build step
test/              Unit tests
```

The web app, the AI features, and the MCP server all go through `store.js`, so every change is validated and logged the same way, no matter who makes it.

**How it maps to Todoist's model**: the same concepts (projects, sections, nested tasks, labels, P1 to P4 priorities, natural-language and recurring due dates, completing a recurring task moves it forward). One difference: Todoist's API stores priority inverted (4 is urgent). Taskline stores it the way you read it: 1 is urgent.

## Development

```bash
npm run dev     # restarts on file changes
npm test        # unit tests, using an in-memory database (never touches your data)
```

## Roadmap

- Calendar sync, so Plan my day knows about your meetings
- A filter language for saved views (like `today & p1 & #Work`)
- Natural-language dates in more languages (Smart add already understands any language)
- Drag and drop reordering

## License

[MIT](LICENSE): free to use, change, and share, as long as the copyright notice stays included.
