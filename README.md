# compact-all

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A [Claude Code](https://claude.com/claude-code) mod that compacts all your
running sessions at once, **only when you ask**.

Long-lived sessions grow during the day. When you come back the next morning,
each one opens with a huge context. Run `/compact-all` before you stop working,
and every session you worked in is compacted the same way `/compact` would do it.

[Русская версия](README.ru.md)

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install compact-all --marketplace a031070/claude-compact-all
```

Answer `y` to add the marketplace, then pick a scope. Choose the **user** scope
so the mod loads in every session.

From a shell:

```bash
claude plugin install compact-all --marketplace a031070/claude-compact-all
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt
box, then **Plugins**, **Add marketplace** with `a031070/claude-compact-all`,
then **Add plugin**.

Sessions that were already open load the mod after they restart.

## Usage

| Command | What it does |
| --- | --- |
| `/compact-all` | Asks every running session you worked in to compact itself. |
| `/compact-all <instructions>` | Same, and passes the text to each compaction, like `/compact <instructions>`. |
| `/compact-all status` | Lists known sessions: folder, turns, context size and the last compaction result. |

Each session compacts **after its current turn ends**, so no running work is
interrupted. The session you typed the command in compacts too.

Skipped:

- sessions where you sent no prompt;
- sessions with under 20,000 context tokens;
- sessions that are not running: a closed session cannot be reached, and the
  report says so.

## How it works

- On start, every session with the mod writes a small entry (session id,
  folder, turns, context tokens) to the mod's own store, under its own key.
  The entry is removed when the session ends; entries not refreshed for 7 days
  are dropped.
- `/compact-all` reads those entries and sends each eligible session a service
  message through `$.session.send`.
- The receiving session's mod takes that message before the model sees it,
  waits until the session is idle and calls `$.session.compact()`, the same
  call `/compact` makes. The result is shown as a toast and in `/compact-all status`.

The mod reads no project files and runs no shell commands.

## Development

```bash
claude plugin validate .
claude plugin test .
```

To run it from this folder without installing:

```bash
claude --plugin-dir .
```

The mod uses the Claude Code hooks-module API, which is in early access and may
change between releases.

## License

[MIT](LICENSE)
