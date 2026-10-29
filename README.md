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

- sessions with no answered prompt in the last 24 hours (the active window,
  see [Settings](#settings));
- sessions where you sent no prompt;
- sessions with under 100,000 context tokens (the `minTokens` option);
- sessions that are not running: a closed session cannot be reached, and the
  report says so.

## Settings

| Option | Default | Meaning |
| --- | --- | --- |
| `activeHours` | `24` | Only sessions whose last prompt was answered within this many hours are compacted. |
| `minTokens` | `100000` | Sessions with a smaller context are skipped. |

Change them in the plugin's settings: `/plugin` in a terminal session, then
**compact-all**. A change reloads the mod with the new values.

## How it works

- On start, every session with the mod writes a small entry (session id,
  folder, turns, context tokens, time of the last answered prompt) to the
  mod's own store, under its own key. The last activity is read at start from
  the transcript file's modification time, so work done before a restart
  counts, and is refreshed after each turn. The entry is removed when the
  session ends or after 7 days without a refresh; a running session whose
  entry went missing writes it again.
- `/compact-all` reads those entries and writes one request to the store,
  naming the eligible sessions.
- Every session checks the store every 15 seconds. A session named in a
  request younger than 30 minutes takes it once, waits until it is idle and
  calls `$.session.compact()`, the same call `/compact` makes. The result is
  shown as a toast and in `/compact-all status`, which also says whether each
  session has taken the request.

No messages pass between sessions, so no permission prompt or auto-mode
verdict is involved. Besides its own store, the mod reads only the modification
time of each session's transcript file, and runs no shell commands.

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
