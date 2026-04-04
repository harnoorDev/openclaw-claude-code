/**
 * Unit tests for OpenAI-compatible /v1/chat/completions endpoint.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveEngineAndModel,
  resolveSessionKey,
  sessionNameFromKey,
  extractUserMessage,
  formatCompletionResponse,
  formatCompletionChunk,
  getModelList,
} from '../openai-compat.js';
import type { OpenAIChatMessage } from '../openai-compat.js';

// ─── resolveEngineAndModel ───────────────────────────────────────────────────

describe('resolveEngineAndModel', () => {
  it('maps claude model names to claude engine', () => {
    expect(resolveEngineAndModel('claude-opus-4-6')).toEqual({ engine: 'claude', model: 'claude-opus-4-6' });
    expect(resolveEngineAndModel('claude-sonnet-4-6')).toEqual({ engine: 'claude', model: 'claude-sonnet-4-6' });
  });

  it('maps short aliases to claude engine', () => {
    expect(resolveEngineAndModel('opus')).toEqual({ engine: 'claude', model: 'claude-opus-4-6' });
    expect(resolveEngineAndModel('sonnet')).toEqual({ engine: 'claude', model: 'claude-sonnet-4-6' });
    expect(resolveEngineAndModel('haiku')).toEqual({ engine: 'claude', model: 'claude-haiku-4-5' });
  });

  it('maps GPT models to codex engine', () => {
    expect(resolveEngineAndModel('gpt-4o')).toEqual({ engine: 'codex', model: 'gpt-4o' });
    expect(resolveEngineAndModel('gpt-4.1')).toEqual({ engine: 'codex', model: 'gpt-4.1' });
  });

  it('maps o-series models to codex engine', () => {
    expect(resolveEngineAndModel('o3')).toEqual({ engine: 'codex', model: 'o3' });
    expect(resolveEngineAndModel('o4-mini')).toEqual({ engine: 'codex', model: 'o4-mini' });
  });

  it('maps gemini models to gemini engine by prefix', () => {
    expect(resolveEngineAndModel('gemini-2.5-pro')).toEqual({ engine: 'gemini', model: 'gemini-2.5-pro' });
    expect(resolveEngineAndModel('gemini-2.5-flash')).toEqual({ engine: 'gemini', model: 'gemini-2.5-flash' });
  });

  it('defaults unknown models to claude engine with passthrough', () => {
    expect(resolveEngineAndModel('my-custom-model')).toEqual({ engine: 'claude', model: 'my-custom-model' });
  });
});

// ─── resolveSessionKey ───────────────────────────────────────────────────────

describe('resolveSessionKey', () => {
  it('prefers X-Session-Id header', () => {
    const key = resolveSessionKey({ messages: [], user: 'user-1' }, { 'x-session-id': 'my-session' });
    expect(key).toBe('my-session');
  });

  it('falls back to user field', () => {
    const key = resolveSessionKey({ messages: [], user: 'user-42' }, {});
    expect(key).toBe('user-42');
  });

  it('falls back to default when nothing provided', () => {
    const key = resolveSessionKey({ messages: [] }, {});
    expect(key).toBe('default');
  });

  it('trims whitespace from header', () => {
    const key = resolveSessionKey({ messages: [] }, { 'x-session-id': '  spaced  ' });
    expect(key).toBe('spaced');
  });

  it('ignores empty header', () => {
    const key = resolveSessionKey({ messages: [], user: 'u1' }, { 'x-session-id': '  ' });
    expect(key).toBe('u1');
  });
});

// ─── sessionNameFromKey ──────────────────────────────────────────────────────

describe('sessionNameFromKey', () => {
  it('prefixes with openai-', () => {
    expect(sessionNameFromKey('abc')).toBe('openai-abc');
    expect(sessionNameFromKey('default')).toBe('openai-default');
  });
});

// ─── extractUserMessage ──────────────────────────────────────────────────────

describe('extractUserMessage', () => {
  it('extracts last user message', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'world' },
    ];
    const result = extractUserMessage(messages);
    expect(result.userMessage).toBe('world');
    expect(result.isNewConversation).toBe(false);
  });

  it('extracts system prompt', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ];
    const result = extractUserMessage(messages);
    expect(result.systemPrompt).toBe('You are helpful.');
    expect(result.userMessage).toBe('hi');
    expect(result.isNewConversation).toBe(true);
  });

  it('detects new conversation (system + single user)', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first message' },
    ];
    expect(extractUserMessage(messages).isNewConversation).toBe(true);
  });

  it('detects ongoing conversation (has assistant turns)', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'msg2' },
    ];
    expect(extractUserMessage(messages).isNewConversation).toBe(false);
  });

  it('handles single user message as new conversation', () => {
    const messages: OpenAIChatMessage[] = [{ role: 'user', content: 'only' }];
    const result = extractUserMessage(messages);
    expect(result.userMessage).toBe('only');
    expect(result.isNewConversation).toBe(true);
    expect(result.systemPrompt).toBeUndefined();
  });

  it('joins multiple system messages', () => {
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: 'line1' },
      { role: 'system', content: 'line2' },
      { role: 'user', content: 'go' },
    ];
    expect(extractUserMessage(messages).systemPrompt).toBe('line1\nline2');
  });

  it('throws on empty messages', () => {
    expect(() => extractUserMessage([])).toThrow('empty');
  });

  it('throws on no user message', () => {
    const messages: OpenAIChatMessage[] = [{ role: 'system', content: 'sys' }];
    expect(() => extractUserMessage(messages)).toThrow('No user message');
  });
});

// ─── formatCompletionResponse ────────────────────────────────────────────────

describe('formatCompletionResponse', () => {
  it('returns valid OpenAI response structure', () => {
    const resp = formatCompletionResponse('chatcmpl-123', 'claude-sonnet-4-6', 'Hello!', 100, 50);
    expect(resp.id).toBe('chatcmpl-123');
    expect(resp.object).toBe('chat.completion');
    expect(resp.model).toBe('claude-sonnet-4-6');
    expect(resp.choices).toHaveLength(1);
    expect(resp.choices[0].message.role).toBe('assistant');
    expect(resp.choices[0].message.content).toBe('Hello!');
    expect(resp.choices[0].finish_reason).toBe('stop');
    expect(resp.usage.prompt_tokens).toBe(100);
    expect(resp.usage.completion_tokens).toBe(50);
    expect(resp.usage.total_tokens).toBe(150);
  });

  it('has a valid created timestamp', () => {
    const before = Math.floor(Date.now() / 1000);
    const resp = formatCompletionResponse('id', 'model', 'text', 0, 0);
    const after = Math.floor(Date.now() / 1000);
    expect(resp.created).toBeGreaterThanOrEqual(before);
    expect(resp.created).toBeLessThanOrEqual(after);
  });
});

// ─── formatCompletionChunk ───────────────────────────────────────────────────

describe('formatCompletionChunk', () => {
  it('returns valid SSE chunk with content delta', () => {
    const chunk = formatCompletionChunk('chatcmpl-1', 'model', { content: 'hi' }, null);
    expect(chunk.id).toBe('chatcmpl-1');
    expect(chunk.object).toBe('chat.completion.chunk');
    expect(chunk.choices[0].delta.content).toBe('hi');
    expect(chunk.choices[0].finish_reason).toBeNull();
  });

  it('returns valid SSE chunk with role delta', () => {
    const chunk = formatCompletionChunk('chatcmpl-1', 'model', { role: 'assistant' }, null);
    expect(chunk.choices[0].delta.role).toBe('assistant');
    expect(chunk.choices[0].delta.content).toBeUndefined();
  });

  it('returns valid final chunk with finish_reason', () => {
    const chunk = formatCompletionChunk('chatcmpl-1', 'model', {}, 'stop');
    expect(chunk.choices[0].finish_reason).toBe('stop');
  });
});

// ─── getModelList ────────────────────────────────────────────────────────────

describe('getModelList', () => {
  it('returns list object with models', () => {
    const list = getModelList();
    expect(list.object).toBe('list');
    expect(list.data.length).toBeGreaterThan(0);
    expect(list.data[0]).toHaveProperty('id');
    expect(list.data[0]).toHaveProperty('object', 'model');
    expect(list.data[0]).toHaveProperty('owned_by');
  });

  it('includes claude, openai, and google models', () => {
    const list = getModelList();
    const owners = new Set(list.data.map((m) => m.owned_by));
    expect(owners).toContain('anthropic');
    expect(owners).toContain('openai');
    expect(owners).toContain('google');
  });
});
