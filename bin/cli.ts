#!/usr/bin/env node
/**
 * claude-code-skill CLI — backward-compatible CLI that uses SessionManager directly
 *
 * This replaces the old HTTP-based CLI. Instead of calling sasha-doctor over HTTP,
 * it directly instantiates SessionManager and calls methods on it.
 *
 * Usage:
 *   claude-code-skill session-start myproject -d ~/project --bare
 *   claude-code-skill session-send myproject "fix the login bug" --stream
 *   claude-code-skill session-stop myproject
 *   claude-code-skill agents-list -d ~/project
 */

import { Command } from 'commander';
import { SessionManager } from '../src/session-manager.js';
import type { EffortLevel } from '../src/types.js';

const program = new Command();
const manager = new SessionManager();

// Graceful shutdown
process.on('SIGINT', async () => { await manager.shutdown(); process.exit(0); });
process.on('SIGTERM', async () => { await manager.shutdown(); process.exit(0); });

program
  .name('claude-code-skill')
  .description('Claude Code SDK — session management, agent teams, and more')
  .version('2.0.0');

// ─── Session Start ───────────────────────────────────────────────────────────

program
  .command('session-start [name]')
  .description('Start a persistent Claude Code session')
  .option('-d, --cwd <dir>', 'Working directory')
  .option('-m, --model <model>', 'Model to use')
  .option('--permission-mode <mode>', 'Permission mode', 'acceptEdits')
  .option('--effort <level>', 'Effort level: low, medium, high, max, auto')
  .option('--allowed-tools <tools>', 'Comma-separated tools to auto-approve')
  .option('--max-turns <n>', 'Maximum agent loop turns')
  .option('--max-budget <usd>', 'Maximum API spend in USD')
  .option('--system-prompt <prompt>', 'Replace system prompt')
  .option('--append-system-prompt <prompt>', 'Append to system prompt')
  .option('--agents <json>', 'Custom sub-agents JSON')
  .option('--agent <name>', 'Default agent')
  .option('--bare', 'Minimal mode')
  .option('-w, --worktree [name]', 'Run in git worktree')
  .option('--fallback-model <model>', 'Fallback model')
  .option('--json-schema <schema>', 'JSON Schema for structured output')
  .option('--mcp-config <paths>', 'MCP config files (comma-separated)')
  .option('--settings <pathOrJson>', 'Settings.json path or inline JSON')
  .option('--skip-persistence', 'Disable session persistence')
  .option('--betas <headers>', 'Custom beta headers')
  .option('--enable-agent-teams', 'Enable agent teams')
  .option('--enable-auto-mode', 'Enable auto permission mode')
  .action(async (name, opts) => {
    try {
      const config: Record<string, unknown> = { name: name || `session-${Date.now()}` };
      if (opts.cwd) config.cwd = opts.cwd;
      if (opts.model) config.model = opts.model;
      if (opts.permissionMode) config.permissionMode = opts.permissionMode;
      if (opts.effort) config.effort = opts.effort;
      if (opts.allowedTools) config.allowedTools = opts.allowedTools.split(',');
      if (opts.maxTurns) config.maxTurns = parseInt(opts.maxTurns);
      if (opts.maxBudget) config.maxBudgetUsd = parseFloat(opts.maxBudget);
      if (opts.systemPrompt) config.systemPrompt = opts.systemPrompt;
      if (opts.appendSystemPrompt) config.appendSystemPrompt = opts.appendSystemPrompt;
      if (opts.agents) config.agents = JSON.parse(opts.agents);
      if (opts.agent) config.agent = opts.agent;
      if (opts.bare) config.bare = true;
      if (opts.worktree !== undefined) config.worktree = typeof opts.worktree === 'string' ? opts.worktree : true;
      if (opts.fallbackModel) config.fallbackModel = opts.fallbackModel;
      if (opts.jsonSchema) config.jsonSchema = opts.jsonSchema;
      if (opts.mcpConfig) config.mcpConfig = opts.mcpConfig.split(',');
      if (opts.settings) config.settings = opts.settings;
      if (opts.skipPersistence) config.noSessionPersistence = true;
      if (opts.betas) config.betas = opts.betas.split(',');
      if (opts.enableAgentTeams) config.enableAgentTeams = true;
      if (opts.enableAutoMode) config.enableAutoMode = true;

      const info = await manager.startSession(config as Parameters<SessionManager['startSession']>[0]);
      console.log(`Session '${info.name}' started!`);
      if (info.claudeSessionId) console.log(`Claude Session ID: ${info.claudeSessionId}`);
    } catch (e) {
      console.error(`Failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─── Session Send ────────────────────────────────────────────────────────────

program
  .command('session-send <name> <message>')
  .description('Send a message to a persistent session')
  .option('--effort <level>', 'Effort level for this message')
  .option('--plan', 'Enable plan mode')
  .option('-t, --timeout <ms>', 'Timeout in ms', '300000')
  .action(async (name, message, opts) => {
    try {
      const result = await manager.sendMessage(name, message, {
        effort: opts.effort as EffortLevel | undefined,
        plan: opts.plan,
        timeout: parseInt(opts.timeout),
      });
      console.log(result.output);
    } catch (e) {
      console.error(`Failed: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// ─── Session Stop ────────────────────────────────────────────────────────────

program
  .command('session-stop <name>')
  .description('Stop a persistent session')
  .action(async (name) => {
    try {
      await manager.stopSession(name);
      console.log(`Session '${name}' stopped.`);
    } catch (e) {
      console.error(`Failed: ${(e as Error).message}`);
    }
  });

// ─── Session List ────────────────────────────────────────────────────────────

program
  .command('session-list')
  .description('List active sessions')
  .action(() => {
    const sessions = manager.listSessions();
    if (sessions.length === 0) { console.log('No active sessions.'); return; }
    for (const s of sessions) {
      console.log(`  ${s.name} — ${s.model || 'default'} (${s.cwd})`);
    }
  });

// ─── Session Status ──────────────────────────────────────────────────────────

program
  .command('session-status <name>')
  .description('Get session status')
  .action((name) => {
    try {
      const status = manager.getStatus(name);
      console.log(`Session: ${status.name}`);
      console.log(`  Model: ${status.model || 'default'}`);
      console.log(`  Turns: ${status.stats.turns}, Tools: ${status.stats.toolCalls}`);
      console.log(`  Tokens: ${status.stats.tokensIn} in / ${status.stats.tokensOut} out`);
      console.log(`  Cost: $${status.stats.costUsd}`);
      console.log(`  Uptime: ${status.stats.uptime}s`);
    } catch (e) {
      console.error(`Failed: ${(e as Error).message}`);
    }
  });

// ─── Session Grep ────────────────────────────────────────────────────────────

program
  .command('session-grep <name> <pattern>')
  .description('Search session history')
  .option('-n, --limit <n>', 'Max results', '50')
  .action(async (name, pattern, opts) => {
    try {
      const matches = await manager.grepSession(name, pattern, parseInt(opts.limit));
      console.log(`Found ${matches.length} match(es):`);
      for (const m of matches) console.log(`  [${m.time}] ${m.type}: ${m.content.substring(0, 120)}`);
    } catch (e) {
      console.error(`Failed: ${(e as Error).message}`);
    }
  });

// ─── Agents ──────────────────────────────────────────────────────────────────

program
  .command('agents-list')
  .description('List agent definitions')
  .option('-d, --cwd <dir>', 'Project directory')
  .action((opts) => {
    const agents = manager.listAgents(opts.cwd);
    if (agents.length === 0) { console.log('No agents found.'); return; }
    for (const a of agents) console.log(`  ${a.name}${a.description ? ` — ${a.description}` : ''}`);
  });

program
  .command('agents-create <name>')
  .description('Create agent definition')
  .option('-d, --cwd <dir>', 'Project directory')
  .option('--description <desc>', 'Description')
  .option('--prompt <prompt>', 'System prompt')
  .action((name, opts) => {
    const p = manager.createAgent(name, opts.cwd, opts.description, opts.prompt);
    console.log(`Agent '${name}' created at: ${p}`);
  });

// ─── Skills ──────────────────────────────────────────────────────────────────

program
  .command('skills-list')
  .description('List skill definitions')
  .option('-d, --cwd <dir>', 'Project directory')
  .action((opts) => {
    const skills = manager.listSkills(opts.cwd);
    if (skills.length === 0) { console.log('No skills found.'); return; }
    for (const s of skills) console.log(`  ${s.name}${s.description ? ` — ${s.description}` : ''}`);
  });

program
  .command('skills-create <name>')
  .description('Create skill definition')
  .option('-d, --cwd <dir>', 'Project directory')
  .option('--description <desc>', 'Description')
  .option('--prompt <prompt>', 'Instructions')
  .option('--trigger <trigger>', 'Trigger condition')
  .action((name, opts) => {
    const p = manager.createSkill(name, opts.cwd, opts);
    console.log(`Skill '${name}' created at: ${p}`);
  });

// ─── Rules ───────────────────────────────────────────────────────────────────

program
  .command('rules-list')
  .description('List conditional rules')
  .option('-d, --cwd <dir>', 'Project directory')
  .action((opts) => {
    const rules = manager.listRules(opts.cwd);
    if (rules.length === 0) { console.log('No rules found.'); return; }
    for (const r of rules) {
      let info = `  ${r.name}`;
      if (r.description) info += ` — ${r.description}`;
      if (r.paths) info += ` [paths: ${r.paths}]`;
      if (r.condition) info += ` [if: ${r.condition}]`;
      console.log(info);
    }
  });

program
  .command('rules-create <name>')
  .description('Create conditional rule')
  .option('-d, --cwd <dir>', 'Project directory')
  .option('--description <desc>', 'Description')
  .option('--content <text>', 'Rule content')
  .option('--paths <glob>', 'File path filter')
  .option('--condition <expr>', 'Condition expression')
  .action((name, opts) => {
    const p = manager.createRule(name, opts.cwd, opts);
    console.log(`Rule '${name}' created at: ${p}`);
  });

// ─── Agent Teams ─────────────────────────────────────────────────────────────

program
  .command('session-team-list <name>')
  .description('List teammates in a team session')
  .action(async (name) => {
    try {
      const response = await manager.teamList(name);
      console.log(response || 'No team info available');
    } catch (e) {
      console.error(`Failed: ${(e as Error).message}`);
    }
  });

program
  .command('session-team-send <name> <teammate> <message>')
  .description('Send message to a teammate')
  .action(async (name, teammate, message) => {
    try {
      const result = await manager.teamSend(name, teammate, message);
      console.log(result.output || 'Message sent');
    } catch (e) {
      console.error(`Failed: ${(e as Error).message}`);
    }
  });

program.parse();
