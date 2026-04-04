/**
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Bridges OpenAI API format to persistent Claude Code sessions, enabling
 * webchat frontends (ChatGPT-Next-Web, Open WebUI, etc.) to use the plugin
 * as a drop-in backend. Stateful sessions maximize Anthropic prompt caching.
 */

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { EngineType } from './types.js';
import {
  OPENAI_COMPAT_DEFAULT_MODEL,
  OPENAI_COMPAT_AUTO_COMPACT_THRESHOLD,
  OPENAI_COMPAT_SESSION_PREFIX,
} from './constants.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAIChatCompletionRequest {
  model?: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  user?: string;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop' | 'length';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

// ─── Model → Engine Mapping ──────────────────────────────────────────────────

interface EngineModelMapping {
  engine: EngineType;
  model: string;
}

const MODEL_ENGINE_MAP: Record<string, EngineModelMapping> = {
  // Claude aliases
  opus: { engine: 'claude', model: 'claude-opus-4-6' },
  sonnet: { engine: 'claude', model: 'claude-sonnet-4-6' },
  haiku: { engine: 'claude', model: 'claude-haiku-4-5' },
  // OpenAI models → codex engine
  'gpt-4o': { engine: 'codex', model: 'gpt-4o' },
  'gpt-4.1': { engine: 'codex', model: 'gpt-4.1' },
  o3: { engine: 'codex', model: 'o3' },
  'o3-mini': { engine: 'codex', model: 'o3-mini' },
  'o4-mini': { engine: 'codex', model: 'o4-mini' },
};

/**
 * Resolve an OpenAI model string to engine + model.
 * Gemini models → gemini engine, GPT/o-series → codex, default → claude.
 */
export function resolveEngineAndModel(model: string): EngineModelMapping {
  // Exact match in map
  const mapped = MODEL_ENGINE_MAP[model];
  if (mapped) return mapped;

  // Pattern-based detection
  if (model.startsWith('gemini')) return { engine: 'gemini', model };
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4'))
    return { engine: 'codex', model };

  // Default: claude engine, pass model through
  return { engine: 'claude', model };
}

// ─── Session Key Resolution ──────────────────────────────────────────────────

/**
 * Derive a session key from the request.
 * Priority: X-Session-Id header > user field > "default"
 */
export function resolveSessionKey(body: OpenAIChatCompletionRequest, headers: http.IncomingHttpHeaders): string {
  const headerKey = headers['x-session-id'];
  if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();
  if (body.user && body.user.trim()) return body.user.trim();
  return 'default';
}

/** Build the full session name from a key */
export function sessionNameFromKey(key: string): string {
  return `${OPENAI_COMPAT_SESSION_PREFIX}${key}`;
}

// ─── Message Extraction ──────────────────────────────────────────────────────

export interface ExtractedMessage {
  systemPrompt: string | undefined;
  userMessage: string;
  isNewConversation: boolean;
}

/**
 * Extract the relevant parts from an OpenAI messages array.
 * Since sessions are stateful, we only need the last user message.
 * A "new conversation" is detected when the array is short (system + user only).
 */
export function extractUserMessage(messages: OpenAIChatMessage[]): ExtractedMessage {
  if (!messages || messages.length === 0) {
    throw new Error('messages array is empty');
  }

  // Extract system prompt if present
  const systemMessages = messages.filter((m) => m.role === 'system');
  const systemPrompt = systemMessages.length > 0 ? systemMessages.map((m) => m.content).join('\n') : undefined;

  // Find last user message
  const userMessages = messages.filter((m) => m.role === 'user');
  if (userMessages.length === 0) {
    throw new Error('No user message found in messages array');
  }
  const userMessage = userMessages[userMessages.length - 1].content;

  // Detect new conversation: only system + first user message (no assistant turns yet)
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');
  const isNewConversation = nonSystemMessages.length <= 1;

  return { systemPrompt, userMessage, isNewConversation };
}

// ─── Response Formatting ─────────────────────────────────────────────────────

export function formatCompletionResponse(
  id: string,
  model: string,
  text: string,
  tokensIn: number,
  tokensOut: number,
): OpenAIChatCompletionResponse {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: tokensIn,
      completion_tokens: tokensOut,
      total_tokens: tokensIn + tokensOut,
    },
  };
}

export function formatCompletionChunk(
  id: string,
  model: string,
  delta: { role?: string; content?: string },
  finishReason: string | null,
): OpenAIChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

// ─── Supported Models List ───────────────────────────────────────────────────

export function getModelList(): { object: string; data: Array<{ id: string; object: string; owned_by: string }> } {
  return {
    object: 'list',
    data: [
      { id: 'claude-opus-4-6', object: 'model', owned_by: 'anthropic' },
      { id: 'claude-sonnet-4-6', object: 'model', owned_by: 'anthropic' },
      { id: 'claude-haiku-4-5', object: 'model', owned_by: 'anthropic' },
      { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
      { id: 'o3', object: 'model', owned_by: 'openai' },
      { id: 'o4-mini', object: 'model', owned_by: 'openai' },
      { id: 'gemini-2.5-pro', object: 'model', owned_by: 'google' },
      { id: 'gemini-2.5-flash', object: 'model', owned_by: 'google' },
    ],
  };
}

// ─── Main Handler ────────────────────────────────────────────────────────────

/** SessionManager-like interface to avoid circular imports */
interface SessionManagerLike {
  startSession(config: Record<string, unknown>): Promise<{ name: string }>;
  sendMessage(
    name: string,
    message: string,
    options?: Record<string, unknown>,
  ): Promise<{ output: string; sessionId?: string; events: unknown[] }>;
  stopSession(name: string): Promise<void>;
  listSessions(): Array<{ name: string }>;
  getStatus(name: string): { stats: { tokensIn: number; tokensOut: number; contextPercent: number } };
  compactSession(name: string): Promise<unknown>;
}

export async function handleChatCompletion(
  manager: SessionManagerLike,
  body: Record<string, unknown>,
  headers: http.IncomingHttpHeaders,
  res: http.ServerResponse,
): Promise<void> {
  const request = body as unknown as OpenAIChatCompletionRequest;

  // Validate
  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error' },
      }),
    );
    return;
  }

  const modelStr = request.model || OPENAI_COMPAT_DEFAULT_MODEL;
  const { engine, model: resolvedModel } = resolveEngineAndModel(modelStr);
  const sessionKey = resolveSessionKey(request, headers);
  const sessionName = sessionNameFromKey(sessionKey);
  const isStreaming = request.stream === true;

  let extracted: ExtractedMessage;
  try {
    extracted = extractUserMessage(request.messages);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'invalid_request_error' } }));
    return;
  }

  // Check if session exists
  const existingSessions = manager.listSessions().map((s) => s.name);
  const sessionExists = existingSessions.includes(sessionName);

  // If new conversation detected and session exists, stop old one first
  if (extracted.isNewConversation && sessionExists) {
    try {
      await manager.stopSession(sessionName);
    } catch {
      /* session may have already been cleaned up */
    }
  }

  // Create session if needed
  const needsCreate = !sessionExists || extracted.isNewConversation;
  if (needsCreate) {
    const sessionConfig: Record<string, unknown> = {
      name: sessionName,
      cwd: process.cwd(),
      engine,
      model: resolvedModel,
      permissionMode: 'bypassPermissions',
    };
    if (extracted.systemPrompt) {
      sessionConfig.appendSystemPrompt = extracted.systemPrompt;
    }
    try {
      await manager.startSession(sessionConfig);
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: `Failed to start session: ${(err as Error).message}`, type: 'server_error' },
        }),
      );
      return;
    }
  }

  // Auto-compact if context is getting full
  if (sessionExists && !needsCreate) {
    try {
      const status = manager.getStatus(sessionName);
      if (status.stats.contextPercent > OPENAI_COMPAT_AUTO_COMPACT_THRESHOLD) {
        await manager.compactSession(sessionName);
      }
    } catch {
      /* best effort — session may not support compact */
    }
  }

  const completionId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 29)}`;

  if (isStreaming) {
    await handleStreaming(manager, sessionName, resolvedModel, extracted.userMessage, completionId, res);
  } else {
    await handleNonStreaming(manager, sessionName, resolvedModel, extracted.userMessage, completionId, res);
  }
}

// ─── Non-Streaming ───────────────────────────────────────────────────────────

async function handleNonStreaming(
  manager: SessionManagerLike,
  sessionName: string,
  model: string,
  userMessage: string,
  completionId: string,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const result = await manager.sendMessage(sessionName, userMessage);
    let tokensIn = 0;
    let tokensOut = 0;
    try {
      const status = manager.getStatus(sessionName);
      tokensIn = status.stats.tokensIn;
      tokensOut = status.stats.tokensOut;
    } catch {
      /* stats unavailable */
    }
    const response = formatCompletionResponse(completionId, model, result.output, tokensIn, tokensOut);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: (err as Error).message, type: 'server_error' } }));
  }
}

// ─── Streaming ───────────────────────────────────────────────────────────────

async function handleStreaming(
  manager: SessionManagerLike,
  sessionName: string,
  model: string,
  userMessage: string,
  completionId: string,
  res: http.ServerResponse,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let clientDisconnected = false;
  res.on('close', () => {
    clientDisconnected = true;
  });

  const writeSSE = (data: string) => {
    if (!clientDisconnected) {
      try {
        res.write(`data: ${data}\n\n`);
      } catch {
        clientDisconnected = true;
      }
    }
  };

  // Initial chunk with role
  writeSSE(JSON.stringify(formatCompletionChunk(completionId, model, { role: 'assistant' }, null)));

  try {
    await manager.sendMessage(sessionName, userMessage, {
      onChunk: (chunk: string) => {
        writeSSE(JSON.stringify(formatCompletionChunk(completionId, model, { content: chunk }, null)));
      },
    });

    // Final chunk with finish_reason
    writeSSE(JSON.stringify(formatCompletionChunk(completionId, model, {}, 'stop')));
    writeSSE('[DONE]');
  } catch (err) {
    // Send error as SSE event then close
    writeSSE(JSON.stringify({ error: { message: (err as Error).message, type: 'server_error' } }));
    writeSSE('[DONE]');
  }

  if (!clientDisconnected) {
    res.end();
  }
}
