# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-30

### Added

- `minTokens` option: sessions with a smaller context are skipped.

### Changed

- The default size floor is now 100,000 context tokens (was 20,000).

## [0.2.0] - 2026-10-30

### Added

- `activeHours` option (default 24): only sessions with a prompt answered
  within that window are compacted.
- `/compact-all status` shows when each session was last active.

### Changed

- Sessions with no recorded activity in the window are now skipped. Sessions
  started before this version count as active after their next turn.

## [0.1.0] - 2026-10-30

### Added

- `/compact-all` command: asks every running session that loaded the mod to
  compact itself once its current turn ends.
- `/compact-all <instructions>`: passes the text to each compaction, as
  `/compact <instructions>` does.
- `/compact-all status`: lists known sessions, their size and the last result.
- Sessions without user prompts or with under 20,000 context tokens are skipped.

[0.3.0]: https://github.com/a031070/claude-compact-all/releases/tag/v0.3.0
[0.2.0]: https://github.com/a031070/claude-compact-all/releases/tag/v0.2.0
[0.1.0]: https://github.com/a031070/claude-compact-all/releases/tag/v0.1.0
