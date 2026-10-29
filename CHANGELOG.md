# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-30

### Added

- `/compact-all` command: asks every running session that loaded the mod to
  compact itself once its current turn ends.
- `/compact-all <instructions>`: passes the text to each compaction, as
  `/compact <instructions>` does.
- `/compact-all status`: lists known sessions, their size and the last result.
- Sessions without user prompts or with under 20,000 context tokens are skipped.

[0.1.0]: https://github.com/a031070/claude-compact-all/releases/tag/v0.1.0
