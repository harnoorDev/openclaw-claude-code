/**
 * Council — Multi-agent collaboration engine
 *
 * Ported from three-minds and adapted to use SessionManager + ISession
 * directly (no HTTP/SSE to external services).
 *
 * Key patterns:
 * - Git worktree isolation per agent
 * - Two-phase protocol: planning round → execution rounds
 * - Consensus voting: all agents vote YES to complete
 * - Parallel execution via Promise.allSettled
 * - Engine-agnostic: agents can use Claude, Codex, or any ISession engine
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type CouncilConfig,
  type CouncilSession,
  type AgentResponse,
  type AgentPersona,
  type CouncilEvent,
  type EngineType,
} from './types.js';
import { parseConsensus, stripConsensusTags, hasConsensusMarker } from './consensus.js';

// Forward-declare SessionManager to avoid circular imports at the type level.
// The actual instance is injected via constructor.
interface SessionManagerLike {
  startSession(config: Record<string, unknown>): Promise<{ name: string; claudeSessionId?: string }>;
  sendMessage(name: string, message: string, options?: Record<string, unknown>): Promise<{ output: string }>;
  stopSession(name: string): Promise<void>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000; // 30 min / agent
const MIN_TASK_LENGTH = 5;
const INTER_ROUND_DELAY_MS = 3000;
const EMPTY_RESPONSE_MAX_RETRIES = 2;
const EMPTY_RESPONSE_RETRY_DELAY_MS = 5000;
const MIN_COMPLETE_RESPONSE_LENGTH = 100;
const FOLLOWUP_MAX_RETRIES = 2;
const HISTORY_PREVIEW_CHARS = 1500;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Git Utilities ──────────────────────────────────────────────────────────

function spawnAsync(
  cmd: string,
  args: string[],
  opts: { timeout?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = opts.timeout
      ? setTimeout(() => { child.kill('SIGTERM'); reject(new Error('spawn timeout')); }, opts.timeout)
      : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0) reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
      else resolve({ stdout, stderr });
    });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
  });
}

/** Set up git worktrees — one isolated directory per agent */
async function setupWorktrees(
  projectDir: string,
  agents: AgentPersona[],
): Promise<Map<string, string>> {
  const worktreeMap = new Map<string, string>();

  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  // Ensure git repo
  const isGit = await spawnAsync('git', ['-C', projectDir, 'rev-parse', '--git-dir'], { timeout: 5000 })
    .then(() => true).catch(() => false);
  if (!isGit) {
    await spawnAsync('git', ['-C', projectDir, 'init'], { timeout: 5000 });
  }

  // Git user config
  await spawnAsync('git', ['-C', projectDir, 'config', 'user.email', 'council@openclaw'], { timeout: 5000 }).catch(() => {});
  await spawnAsync('git', ['-C', projectDir, 'config', 'user.name', 'Council'], { timeout: 5000 }).catch(() => {});

  // Ensure at least one commit
  const hasCommit = await spawnAsync('git', ['-C', projectDir, 'rev-parse', 'HEAD'], { timeout: 5000 })
    .then(() => true).catch(() => false);
  if (!hasCommit) {
    await spawnAsync('git', ['-C', projectDir, 'add', '-A'], { timeout: 5000 }).catch(() => {});
    await spawnAsync('git', ['-C', projectDir, 'commit', '--allow-empty', '-m', 'council: initial'], { timeout: 5000 });
  }

  // Create worktree per agent
  for (const agent of agents) {
    const wtDir = path.join(projectDir, '.worktrees', agent.name);
    const branch = `council/${agent.name}`;

    if (fs.existsSync(wtDir)) {
      const isValid = await spawnAsync('git', ['-C', wtDir, 'rev-parse', '--git-dir'], { timeout: 5000 })
        .then(() => true).catch(() => false);
      if (isValid) {
        await spawnAsync('git', ['-C', wtDir, 'checkout', branch], { timeout: 5000 }).catch(() => {});
        await spawnAsync('git', ['-C', wtDir, 'reset', '--hard', 'HEAD'], { timeout: 5000 }).catch(() => {});
        worktreeMap.set(agent.name, wtDir);
        continue;
      }
      await spawnAsync('git', ['-C', projectDir, 'worktree', 'remove', '--force', wtDir], { timeout: 5000 }).catch(() => {});
    }

    await spawnAsync('git', ['-C', projectDir, 'branch', '-D', branch], { timeout: 5000 }).catch(() => {});
    await spawnAsync('git', ['-C', projectDir, 'worktree', 'add', wtDir, '-b', branch], { timeout: 5000 });

    if (!fs.existsSync(wtDir)) {
      throw new Error(`Worktree directory not created: ${wtDir}`);
    }
    worktreeMap.set(agent.name, wtDir);
  }

  // Write CLAUDE.md constraints in each worktree
  for (const agent of agents) {
    const wtDir = worktreeMap.get(agent.name);
    if (wtDir) writeWorktreeClaudeMd(wtDir, agent.name, agent.emoji, projectDir);
  }

  return worktreeMap;
}

function writeWorktreeClaudeMd(wtDir: string, agentName: string, emoji: string, projectDir: string) {
  const claudeDir = path.join(wtDir, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
  const content = `# ${emoji} ${agentName}

> Auto-generated by council. Takes priority over all conversation context.

## Identity

You are **${emoji} ${agentName}**.
Your branch: \`council/${agentName}\`
Your working directory: \`${wtDir}\`

Only tasks marked \`[Claimed: council/${agentName}]\` in plan.md belong to you.

## Workspace Boundary

Only operate within \`${wtDir}\` and \`${projectDir}\`.
Do NOT access: \`~/\`, \`/Users/\`, \`~/.openclaw/\`, or any path outside the workspace.

## Efficiency

- Complete round 1 in 2-3 minutes (planning only)
- Empty project = start immediately, no exploration needed
- \`ls\` once is enough, do not scan repeatedly
`;
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), content);
}

// ─── Prompt Building ────────────────────────────────────────────────────────

function buildAgentPrompt(
  agent: AgentPersona,
  task: string,
  round: number,
  previousResponses: AgentResponse[],
  allAgents: AgentPersona[],
): string {
  const otherAgents = allAgents.filter(a => a.name !== agent.name);

  // Build history with tail-first truncation (preserve reports and votes)
  let history = '';
  if (previousResponses.length > 0) {
    history = '\n\n## Previous collaboration history\n\n';
    let currentRound = 0;
    for (const resp of previousResponses) {
      if (resp.round !== currentRound) {
        currentRound = resp.round;
        history += `### Round ${currentRound}\n\n`;
      }
      const clean = stripConsensusTags(resp.content);
      const preview = clean.length > HISTORY_PREVIEW_CHARS
        ? '...' + clean.slice(-HISTORY_PREVIEW_CHARS)
        : clean;
      history += `**${resp.agent}** (${resp.consensus ? 'YES' : 'NO'}):\n${preview}\n\n`;
    }
  }

  if (round === 1) {
    return `# Round 1 — Planning Round

## Task
${task}

## Your teammates
${otherAgents.map(a => `- ${a.emoji} ${a.name}`).join('\n')}
${history}
## Rules: planning only, no code

This is round 1 — **pure planning**. All members work in parallel.

**You must (in order, quickly):**
1. \`git log --oneline -5\` to check current state
2. If project is empty, write plan directly from the task description
3. If project has code, \`ls\` once then write plan
4. Create \`plan.md\` (task checklist, phases, claim status) and merge to main
5. If main already has plan.md from others, merge your improvements

**You must NOT:**
- Write any business code
- Explore directories repeatedly
- Spend more than 2-3 minutes

## Consensus Vote

At the **end** of your reply, vote:
- \`[CONSENSUS: NO]\` — normal for round 1 (still need execution)
- \`[CONSENSUS: YES]\` — only if task is trivially simple

Start writing plan.md now!`;
  }

  return `# Round ${round} — Execution

## Task
${task}

## Your teammates
${otherAgents.map(a => `- ${a.emoji} ${a.name}`).join('\n')}
${history}
## Your work

plan.md was created in round 1. Now execute:

1. **Check status** — pull main, read plan.md, understand progress
2. **Claim and execute** — pick unclaimed tasks, write code, run tests
3. **Review others** — if teammates have output, review and improve
4. **Report results** — brief summary of what you did

## Consensus Vote

At the **end**, vote (pick one):
- \`[CONSENSUS: YES]\` — task complete, quality acceptable
- \`[CONSENSUS: NO]\` — more work needed

All agents must vote YES for the council to finish.

Start working!`;
}

function buildSystemPrompt(
  agent: AgentPersona,
  allAgents: AgentPersona[],
  worktreePath: string,
): string {
  const otherAgents = allAgents.filter(a => a.name !== agent.name);
  const otherBranches = otherAgents.map(a => `\`council/${a.name}\``).join(', ');

  return `# System Prompt

You are an expert software engineer agent, codename **${agent.emoji} ${agent.name}**.
You are part of a "Council" with other agents, collaborating to deliver the task to the \`main\` branch (local merge only, **never push**).

**Your traits**: ${agent.persona}

## Environment (Multi-Worktree)

* **Your directory**: \`${worktreePath}\`
* **Your branch**: \`council/${agent.name}\`
* **Target branch**: \`main\`
* **Other branches**: ${otherBranches}

## Core Rules

1. **Use tools to execute** — never fabricate results, always run commands
2. **plan.md is the single source of truth** — track in git
3. **Parallel work** — you run simultaneously with others, pull main before starting
4. **Claim tasks** with \`[Claimed: council/${agent.name}]\`, complete with \`[Done: council/${agent.name}]\`
5. **Merge to main** locally — never push
6. **Resolve conflicts** yourself — never stop on conflict
7. **Action over words** — if plan.md has unclaimed tasks, work on them

## Commit Format

\`\`\`
council(<phase>): ${agent.name} - <description>
\`\`\`

## Report Format

\`\`\`markdown
## Report (${agent.name})
- **Git status**: (latest commit hash on main)
- **Plan changes**: (what you updated in plan.md)
- **Integration**: (merged to main? test results?)
- **Review**: (reviewed whose work? conclusion?)
- **Next**: (suggest next priority)

[CONSENSUS: YES] or [CONSENSUS: NO]
\`\`\`
`;
}

// ─── Council Engine ─────────────────────────────────────────────────────────

export class Council extends EventEmitter {
  private config: CouncilConfig;
  private manager: SessionManagerLike;
  private agentTimeoutMs: number;
  private _aborted = false;
  private _activeSessions = new Set<string>();
  private _session: CouncilSession | null = null;
  private _pendingInjection: string | null = null;

  constructor(config: CouncilConfig, manager: SessionManagerLike) {
    super();
    this.config = config;
    this.manager = manager;
    this.agentTimeoutMs = config.agentTimeoutMs || DEFAULT_AGENT_TIMEOUT_MS;
  }

  getSession(): CouncilSession | undefined {
    return this._session ?? undefined;
  }

  injectMessage(message: string): void {
    this._pendingInjection = message;
  }

  abort(): void {
    this._aborted = true;
    for (const name of this._activeSessions) {
      this.manager.stopSession(name).catch(() => {});
    }
    this._activeSessions.clear();
  }

  private emitEvent(event: Omit<CouncilEvent, 'timestamp'>) {
    const full: CouncilEvent = { ...event, timestamp: new Date().toISOString() };
    this.emit('council-event', full);
  }

  // ─── Single Agent Execution ───────────────────────────────────────────

  private async runSingleAgent(
    agent: AgentPersona,
    prompt: string,
    systemPrompt: string,
    workDir: string,
    round: number,
    sessionId: string,
  ): Promise<AgentResponse> {
    this.emitEvent({ type: 'agent-start', sessionId, round, agent: agent.name });

    const sessionName = `council-${sessionId.slice(0, 8)}-${agent.name}-r${round}`;
    this._activeSessions.add(sessionName);

    let content = '';
    try {
      for (let attempt = 0; attempt <= EMPTY_RESPONSE_MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          this.emitEvent({
            type: 'agent-chunk', sessionId, round, agent: agent.name,
            content: `\n[Empty response, retry ${attempt}/${EMPTY_RESPONSE_MAX_RETRIES}]\n`,
          });
          await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
        }

        // Start a session for this agent
        const engine: EngineType = agent.engine || 'claude';
        await this.manager.startSession({
          name: sessionName,
          cwd: workDir,
          engine,
          model: agent.model,
          baseUrl: agent.baseUrl,
          permissionMode: 'bypassPermissions',
          appendSystemPrompt: systemPrompt,
          maxTurns: this.config.maxTurnsPerAgent || 30,
          maxBudgetUsd: this.config.maxBudgetUsd,
        });

        // Send the prompt and wait for completion
        const result = await this.manager.sendMessage(sessionName, prompt, {
          timeout: this.agentTimeoutMs,
          onChunk: (chunk: string) => {
            this.emitEvent({ type: 'agent-chunk', sessionId, round, agent: agent.name, content: chunk });
          },
        });

        content = result.output;

        // Check if response is substantive
        const stripped = content.replace(/^\[Agent completed[^\]]*\]\s*/i, '').trim();
        if (stripped.length > 0 || hasConsensusMarker(content)) break;

        if (attempt === EMPTY_RESPONSE_MAX_RETRIES) {
          console.log(`[Council] ${agent.name}: empty after ${EMPTY_RESPONSE_MAX_RETRIES} retries`);
        }
      }

      // Follow-up if response is too short and has no consensus marker
      const strippedContent = content.replace(/^\[Agent completed[^\]]*\]\s*/i, '').trim();
      if (strippedContent.length < MIN_COMPLETE_RESPONSE_LENGTH && !hasConsensusMarker(content)) {
        for (let i = 0; i < FOLLOWUP_MAX_RETRIES; i++) {
          try {
            const followup = await this.manager.sendMessage(
              sessionName,
              'Stop all tool calls. Output your complete report now, including your consensus vote [CONSENSUS: YES] or [CONSENSUS: NO].',
              { timeout: 60_000 },
            );
            if (followup.output.trim().length > 0) {
              content = followup.output;
              if (hasConsensusMarker(content) || content.length >= MIN_COMPLETE_RESPONSE_LENGTH) break;
            }
          } catch {
            break;
          }
          await sleep(EMPTY_RESPONSE_RETRY_DELAY_MS);
        }
      }
    } finally {
      // Stop session — fire-and-forget
      this.manager.stopSession(sessionName).catch(() => {});
      this._activeSessions.delete(sessionName);
    }

    const consensus = parseConsensus(content);
    const response: AgentResponse = {
      agent: agent.name,
      round,
      content,
      consensus,
      sessionKey: sessionName,
      timestamp: new Date().toISOString(),
    };

    this.emitEvent({ type: 'agent-complete', sessionId, round, agent: agent.name, content, consensus });
    return response;
  }

  // ─── Main Orchestration Loop ──────────────────────────────────────────

  async run(task: string): Promise<CouncilSession> {
    if (!task || task.trim().length < MIN_TASK_LENGTH) {
      throw new Error(`Task description too short (min ${MIN_TASK_LENGTH} chars)`);
    }
    const trimmedTask = task.trim();

    const session: CouncilSession = {
      id: randomUUID(),
      task: trimmedTask,
      config: this.config,
      responses: [],
      status: 'running',
      startTime: new Date().toISOString(),
    };
    this._session = session;

    console.log(`[Council] Starting: ${this.config.agents.length} agents, max ${this.config.maxRounds} rounds`);
    console.log(`[Council] Task: ${trimmedTask}`);
    console.log(`[Council] Dir: ${this.config.projectDir}`);
    this.emitEvent({ type: 'session-start', sessionId: session.id, task: trimmedTask });

    // Set up git worktrees
    let worktreeMap: Map<string, string>;
    try {
      worktreeMap = await setupWorktrees(this.config.projectDir, this.config.agents);
    } catch (err) {
      session.status = 'error';
      session.endTime = new Date().toISOString();
      throw err;
    }

    console.log('[Council] Worktrees:');
    for (const [name, wtPath] of worktreeMap) {
      console.log(`  ${name}: ${wtPath}`);
    }

    try {
      for (let round = 1; round <= this.config.maxRounds; round++) {
        if (this._aborted) break;

        console.log(`\n[Council] Round ${round} (${this.config.agents.length} agents parallel)`);
        this.emitEvent({ type: 'round-start', sessionId: session.id, round });

        // Check for user injection
        const injection = this._pendingInjection;
        this._pendingInjection = null;

        // Build prompts for all agents
        const agentTasks = this.config.agents.map(agent => {
          const workDir = worktreeMap.get(agent.name) || this.config.projectDir;
          let prompt = buildAgentPrompt(agent, trimmedTask, round, session.responses, this.config.agents);
          if (injection) {
            prompt += `\n\n## User Injection\n\n${injection}`;
          }
          const systemPrompt = buildSystemPrompt(agent, this.config.agents, workDir);
          return { agent, prompt, systemPrompt, workDir };
        });

        // Execute all agents in parallel
        const results = await Promise.allSettled(
          agentTasks.map(({ agent, prompt, systemPrompt, workDir }) =>
            this.runSingleAgent(agent, prompt, systemPrompt, workDir, round, session.id)
          ),
        );

        // Collect results
        const roundVotes: boolean[] = [];
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const agent = this.config.agents[i];
          if (result.status === 'fulfilled') {
            roundVotes.push(result.value.consensus);
            session.responses.push(result.value);
          } else {
            const errMsg = (result.reason as Error)?.message || 'Unknown error';
            console.log(`[Council] ${agent.name} failed: ${errMsg}`);
            this.emitEvent({ type: 'error', sessionId: session.id, round, agent: agent.name, error: errMsg });
            roundVotes.push(false);
            session.responses.push({
              agent: agent.name, round, content: `Error: ${errMsg}`,
              consensus: false, sessionKey: '', timestamp: new Date().toISOString(),
            });
          }
        }

        const allYes = roundVotes.length === this.config.agents.length && roundVotes.every(v => v);
        this.emitEvent({ type: 'round-end', sessionId: session.id, round, status: allYes ? 'consensus' : 'continue' });

        if (allYes) {
          console.log(`[Council] Consensus reached at round ${round}`);
          session.status = 'awaiting_user';
          break;
        } else {
          const yesCount = roundVotes.filter(v => v).length;
          console.log(`[Council] Votes: ${yesCount}/${this.config.agents.length} YES`);
        }

        if (round < this.config.maxRounds) {
          await sleep(INTER_ROUND_DELAY_MS);
        }
      }

      if (this._aborted) {
        session.status = 'error';
      } else if (session.status === 'running') {
        session.status = 'max_rounds';
        console.log(`[Council] Max rounds (${this.config.maxRounds}) reached`);
      }

      session.endTime = new Date().toISOString();
      session.compactContext = this.generateCompactContext(session);
      session.finalSummary = this.generateSummary(session);
      this.saveTranscript(session);

      this.emitEvent({ type: 'complete', sessionId: session.id, status: session.status });
      return session;
    } catch (err) {
      session.status = 'error';
      session.endTime = new Date().toISOString();
      this.emitEvent({ type: 'error', sessionId: session.id, error: (err as Error).message });
      throw err;
    }
  }

  // ─── Summary & Transcript ─────────────────────────────────────────────

  private generateSummary(session: CouncilSession): string {
    const maxRound = session.responses.length > 0
      ? Math.max(...session.responses.map(r => r.round))
      : 0;
    const statusText = session.status === 'awaiting_user' || session.status === 'consensus'
      ? 'Consensus reached'
      : 'Max rounds reached';
    const lines = [
      `# Council Summary\n`,
      `- **Task**: ${session.task}`,
      `- **Status**: ${statusText}`,
      `- **Rounds**: ${maxRound}`,
      `- **Directory**: ${session.config.projectDir}\n`,
      `## Final Agent Status\n`,
    ];
    const lastResponses = session.responses.filter(r => r.round === maxRound);
    for (const resp of lastResponses) {
      const agent = session.config.agents.find(a => a.name === resp.agent);
      const emoji = agent?.emoji || '';
      const clean = stripConsensusTags(resp.content);
      const preview = clean.slice(0, 400) + (clean.length > 400 ? '...' : '');
      lines.push(`### ${emoji} ${resp.agent}`);
      lines.push(`- Vote: ${resp.consensus ? 'YES' : 'NO'}`);
      lines.push(`- Summary:\n${preview}\n`);
    }
    return lines.join('\n');
  }

  private generateCompactContext(session: CouncilSession): string {
    const maxRound = session.responses.length > 0
      ? Math.max(...session.responses.map(r => r.round))
      : 0;
    const recent = session.responses.filter(r => r.round >= maxRound - 1);
    const summaries = recent.map(resp => {
      const clean = stripConsensusTags(resp.content).replace(/\s+/g, ' ').slice(0, 300);
      return `- [R${resp.round}] ${resp.agent}: ${clean}${clean.length >= 300 ? '...' : ''}`;
    });
    return [
      `Task: ${session.task}`,
      `Progress: round ${maxRound} / max ${session.config.maxRounds}`,
      `Status: ${session.status}`,
      'Latest:',
      ...summaries,
    ].join('\n');
  }

  private saveTranscript(session: CouncilSession): void {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logDir = path.join(process.env.HOME || '/tmp', '.openclaw', 'council-logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const filepath = path.join(logDir, `council-${ts}.md`);

    let content = `# Council Transcript\n\n`;
    content += `- **Time**: ${session.startTime}\n`;
    content += `- **Task**: ${session.task}\n`;
    content += `- **Status**: ${session.status}\n\n---\n\n`;

    let currentRound = 0;
    for (const resp of session.responses) {
      if (resp.round !== currentRound) {
        currentRound = resp.round;
        content += `## Round ${currentRound}\n\n`;
      }
      const agent = session.config.agents.find(a => a.name === resp.agent);
      content += `### ${agent?.emoji || ''} ${resp.agent}\n\n${resp.content}\n\n`;
    }

    content += `---\n\n${session.finalSummary || ''}`;
    fs.writeFileSync(filepath, content);
    console.log(`[Council] Transcript saved: ${filepath}`);
  }
}

// ─── Default Config ─────────────────────────────────────────────────────────

export function getDefaultCouncilConfig(projectDir: string): CouncilConfig {
  return {
    name: 'Code Council',
    agents: [
      { name: 'Architect', emoji: '🏗️', persona: 'You are a system architect. You focus on code structure, design patterns, scalability, and long-term maintainability.' },
      { name: 'Engineer', emoji: '⚙️', persona: 'You are an implementation engineer. You focus on code quality, error handling, edge cases, and performance.' },
      { name: 'Reviewer', emoji: '🔍', persona: 'You are a code reviewer. You focus on code standards, potential bugs, security issues, and documentation.' },
    ],
    maxRounds: 15,
    projectDir,
  };
}
