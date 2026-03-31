# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-03-31

### Added
- Stream output support — `onChunk` callback and `stream` param for `claude_session_send` (#9)
- Session persistence — registry saved to `~/.openclaw/claude-sessions.json` with 7-day disk TTL, atomic writes, debounced saves (#11)
- Dynamic tool/model switching — `claude_session_update_tools` and `claude_session_switch_model` with rollback on failure (#12)
- Session health overview — `claude_sessions_overview` tool for plugin-wide stats (#10)
- Premature CLI exit detection — startup crash no longer leaves sessions stuck in busy state (#13)

### Fixed
- Stale close listener on fallback ready path (follow-up to #13)
- Truncated code comments in startup flow

### Improved
- Project governance: CONTRIBUTING.md, CHANGELOG.md, issue/PR templates, CI workflows, npm publish automation

## [2.1.0] - 2026-03-31

### Added
- Cross-platform PATH inheritance from `process.env.PATH`
- `CLAUDE_BIN` env var override for custom binary locations
- `resumeSessionId` exposed in tool schema
- Lazy initialization — zero memory when unused

### Fixed
- `contextPercent` calculation (was hardcoded 0)
- Process blocking on detached child (`proc.unref()`)
- Ready event now listens for CLI init signal instead of blind 2s timeout

## [2.0.0] - 2026-03-31

### Added
- Complete rewrite as native OpenClaw plugin
- 10 native tools (`claude_session_start/send/stop/list/status/grep/compact`, `claude_agents_list`, `claude_team_list/send`)
- Plugin hooks: `before_prompt_build`, `registerHttpRoute`
- Embedded HTTP server for backward-compatible CLI access

### Breaking Changes
- Requires OpenClaw >= 2026.3.0 with plugin SDK
- Standalone Express backend deprecated
- FastAPI proxy now optional

## [1.2.0] - 2026-03-27

### Added
- Cost tracking per session
- Git branch awareness
- Hook system for pre/post execution
- Model aliases support

## [1.1.0] - 2026-03-25

### Added
- Effort levels (low/medium/high/max)
- Plan mode (`--plan` flag)
- Compact command for context reclamation
- Context percentage tracking
- Model switching within sessions

## [1.0.0] - 2026-03-23

### Added
- Initial release
- Persistent Claude Code sessions via MCP
- Multi-model proxy support
- Agent teams support
- SKILL.md for ClawHub discovery
