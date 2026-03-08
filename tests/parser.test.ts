import { describe, test, expect } from 'bun:test';
import {
  isAssistantMessage,
  isSessionStart,
  isModelChange,
  parseSessionDirRows,
} from '../src/parser.ts';
import { toTimestamp, estimateTokens, parseProcessLogData } from '../src/utils.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeAssistantMessage(overrides?: {
  messageId?: string;
  content?: string;
  model?: string;
  timestamp?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}): Record<string, unknown> {
  return {
    type: 'assistant.message',
    id: 'evt-001',
    timestamp: overrides?.timestamp ?? '2026-02-27T20:59:11.000Z',
    parentId: null,
    data: {
      messageId: overrides?.messageId ?? 'msg_001',
      content: overrides?.content ?? 'Hello, I can help with that.',
      model: overrides?.model,
      ...(overrides?.usage ? { usage: overrides.usage } : {}),
    },
  };
}

function makeSessionStart(overrides?: {
  sessionId?: string;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    type: 'session.start',
    id: 'evt-start',
    timestamp: overrides?.timestamp ?? '2026-02-27T20:58:52.000Z',
    parentId: null,
    data: {
      sessionId: overrides?.sessionId ?? 'f519f8be-67df-4d12-a3a5-6edf86d85f38',
    },
  };
}

function makeModelChange(overrides?: {
  newModel?: string;
  previousModel?: string;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    type: 'session.model_change',
    id: 'evt-model',
    timestamp: overrides?.timestamp ?? '2026-02-27T20:58:52.000Z',
    parentId: null,
    data: {
      newModel: overrides?.newModel ?? 'claude-opus-4.6-fast',
      ...(overrides?.previousModel ? { previousModel: overrides.previousModel } : {}),
    },
  };
}

function makeToolExecutionComplete(overrides?: {
  model?: string;
  toolCallId?: string;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    type: 'tool.execution_complete',
    id: 'evt-tool',
    timestamp: overrides?.timestamp ?? '2026-02-27T20:59:10.000Z',
    parentId: null,
    data: {
      toolCallId: overrides?.toolCallId ?? 'call_abc123',
      ...(overrides?.model !== undefined ? { model: overrides.model } : {}),
      interactionId: 'interaction-001',
      success: true,
      result: { content: 'done' },
    },
  };
}

// ---------------------------------------------------------------------------
// isAssistantMessage
// ---------------------------------------------------------------------------

describe('isAssistantMessage', () => {
  test('accepts a valid assistant.message event', () => {
    expect(isAssistantMessage(makeAssistantMessage())).toBe(true);
  });

  test('rejects null and undefined', () => {
    expect(isAssistantMessage(null)).toBe(false);
    expect(isAssistantMessage(undefined)).toBe(false);
  });

  test('rejects non-object types', () => {
    expect(isAssistantMessage(42)).toBe(false);
    expect(isAssistantMessage('assistant.message')).toBe(false);
    expect(isAssistantMessage(true)).toBe(false);
  });

  test('rejects events with wrong type field', () => {
    expect(isAssistantMessage({ type: 'user.message', data: {} })).toBe(false);
    expect(isAssistantMessage({ type: 'session.start', data: {} })).toBe(false);
    expect(isAssistantMessage({ type: 'assistant.turn_start', data: {} })).toBe(false);
  });

  test('rejects events without data object', () => {
    expect(isAssistantMessage({ type: 'assistant.message' })).toBe(false);
    expect(isAssistantMessage({ type: 'assistant.message', data: 'string' })).toBe(false);
  });

  test('rejects events with empty or missing messageId', () => {
    expect(isAssistantMessage(makeAssistantMessage({ messageId: '' }))).toBe(false);
    const noId = makeAssistantMessage();
    (noId.data as Record<string, unknown>).messageId = undefined;
    expect(isAssistantMessage(noId)).toBe(false);
  });

  test('rejects events with non-string content', () => {
    const noContent = makeAssistantMessage();
    (noContent.data as Record<string, unknown>).content = undefined;
    expect(isAssistantMessage(noContent)).toBe(false);
  });

  test('accepts events with empty string content', () => {
    expect(isAssistantMessage(makeAssistantMessage({ content: '' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSessionStart
// ---------------------------------------------------------------------------

describe('isSessionStart', () => {
  test('accepts a valid session.start event', () => {
    expect(isSessionStart(makeSessionStart())).toBe(true);
  });

  test('rejects null and undefined', () => {
    expect(isSessionStart(null)).toBe(false);
    expect(isSessionStart(undefined)).toBe(false);
  });

  test('rejects events with wrong type', () => {
    expect(isSessionStart({ type: 'session.end', data: { sessionId: 'abc' } })).toBe(false);
  });

  test('rejects events with missing sessionId', () => {
    expect(isSessionStart({ type: 'session.start', data: {} })).toBe(false);
  });

  test('rejects events with non-string sessionId', () => {
    expect(isSessionStart({ type: 'session.start', data: { sessionId: 123 } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isModelChange
// ---------------------------------------------------------------------------

describe('isModelChange', () => {
  test('accepts a valid session.model_change event', () => {
    expect(isModelChange(makeModelChange())).toBe(true);
  });

  test('rejects null and undefined', () => {
    expect(isModelChange(null)).toBe(false);
    expect(isModelChange(undefined)).toBe(false);
  });

  test('rejects events with wrong type', () => {
    expect(isModelChange({ type: 'session.start', data: { newModel: 'gpt-5' } })).toBe(false);
  });

  test('rejects events with empty newModel', () => {
    expect(isModelChange(makeModelChange({ newModel: '' }))).toBe(false);
  });

  test('rejects events with missing newModel', () => {
    expect(isModelChange({ type: 'session.model_change', data: {} })).toBe(false);
  });

  test('rejects events with non-string newModel', () => {
    expect(isModelChange({ type: 'session.model_change', data: { newModel: 42 } })).toBe(false);
  });

  test('accepts events with optional previousModel', () => {
    expect(isModelChange(makeModelChange({ previousModel: 'claude-sonnet-4.6' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toTimestamp
// ---------------------------------------------------------------------------

describe('toTimestamp', () => {
  test('parses valid ISO 8601 string', () => {
    expect(toTimestamp('2026-02-27T20:59:11.000Z', 0)).toBe(Date.parse('2026-02-27T20:59:11.000Z'));
  });

  test('returns fallback for undefined', () => {
    expect(toTimestamp(undefined, 999)).toBe(999);
  });

  test('returns fallback for empty string', () => {
    expect(toTimestamp('', 999)).toBe(999);
  });

  test('returns fallback for invalid date string', () => {
    expect(toTimestamp('not-a-date', 42)).toBe(42);
  });

  test('handles date-only strings', () => {
    const ts = toTimestamp('2026-02-27', 0);
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  test('estimates ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });

  test('rounds up partial tokens', () => {
    expect(estimateTokens('abc')).toBe(1); // 3/4 = 0.75, ceil = 1
    expect(estimateTokens('abcde')).toBe(2); // 5/4 = 1.25, ceil = 2
  });

  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseSessionDirRows (via mock events)
// ---------------------------------------------------------------------------

// We can't test parseSessionDirRows directly (it reads files), but we can
// test the pure logic by creating temp dirs. Instead, we test the type guards
// and estimation functions above, and add integration-style tests for the
// parsing logic using a temp directory with fixture data.

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

async function createTempSession(events: Record<string, unknown>[], workspace?: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-test-'));
  const eventsContent = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(path.join(tmpDir, 'events.jsonl'), eventsContent);
  if (workspace) {
    await fs.writeFile(path.join(tmpDir, 'workspace.yaml'), workspace);
  }
  return tmpDir;
}

describe('parseSessionDirRows', () => {
  const MTIME = Date.now();
  const DEFAULT_MODEL = 'claude-sonnet-4.6';

  test('parses a single assistant message with estimated tokens', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage({ content: 'Hello world, this is a test response.' }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens.output).toBe(estimateTokens('Hello world, this is a test response.'));
    expect(rows[0]!.tokens.input).toBe(Math.ceil(rows[0]!.tokens.output * 0.5));
    expect(rows[0]!.metadata).toEqual({ isEstimated: true });
    expect(rows[0]!.providerId).toBe('github-copilot');
  });

  test('uses default model when no model change events exist', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage(),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.modelId).toBe(DEFAULT_MODEL);
  });

  test('uses model from session.model_change event', async () => {
    const dir = await createTempSession([
      makeSessionStart({ timestamp: '2026-02-27T20:58:50.000Z' }),
      makeModelChange({ newModel: 'claude-opus-4.6-fast', timestamp: '2026-02-27T20:58:52.000Z' }),
      makeAssistantMessage({ timestamp: '2026-02-27T20:59:11.000Z' }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.modelId).toBe('claude-opus-4.6-fast');
  });

  test('tracks multiple model changes per session', async () => {
    const dir = await createTempSession([
      makeSessionStart({ timestamp: '2026-02-27T20:00:00.000Z' }),
      makeModelChange({ newModel: 'claude-sonnet-4.6', timestamp: '2026-02-27T20:00:01.000Z' }),
      makeAssistantMessage({ messageId: 'msg_001', content: 'First response', timestamp: '2026-02-27T20:01:00.000Z' }),
      makeModelChange({ newModel: 'claude-opus-4.6-fast', timestamp: '2026-02-27T20:02:00.000Z' }),
      makeAssistantMessage({ messageId: 'msg_002', content: 'Second response', timestamp: '2026-02-27T20:03:00.000Z' }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.modelId).toBe('claude-sonnet-4.6');
    expect(rows[1]!.modelId).toBe('claude-opus-4.6-fast');
  });

  test('falls back to default model for messages before any model change', async () => {
    const dir = await createTempSession([
      makeSessionStart({ timestamp: '2026-02-27T20:00:00.000Z' }),
      makeAssistantMessage({ messageId: 'msg_early', content: 'Early', timestamp: '2026-02-27T20:00:30.000Z' }),
      makeModelChange({ newModel: 'gpt-5.1', timestamp: '2026-02-27T20:01:00.000Z' }),
      makeAssistantMessage({ messageId: 'msg_late', content: 'Late', timestamp: '2026-02-27T20:02:00.000Z' }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.modelId).toBe(DEFAULT_MODEL);
    expect(rows[1]!.modelId).toBe('gpt-5.1');
  });

  test('deduplicates by messageId keeping last entry', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage({ messageId: 'msg_001', content: 'partial' }),
      makeAssistantMessage({ messageId: 'msg_001', content: 'partial response' }),
      makeAssistantMessage({ messageId: 'msg_001', content: 'full response with more content' }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens.output).toBe(estimateTokens('full response with more content'));
  });

  test('handles multiple messages with different ids', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage({ messageId: 'msg_001', content: 'First reply' }),
      makeAssistantMessage({ messageId: 'msg_002', content: 'Second reply' }),
      makeAssistantMessage({ messageId: 'msg_003', content: 'Third reply' }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows).toHaveLength(3);
  });

  test('skips non-assistant events', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      { type: 'user.message', id: 'evt-u1', timestamp: '2026-02-27T20:59:09.000Z', parentId: null, data: { content: 'hi' } },
      makeAssistantMessage(),
      { type: 'assistant.turn_end', id: 'evt-te', timestamp: '2026-02-27T20:59:12.000Z', parentId: null, data: { turnId: 't1' } },
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows).toHaveLength(1);
  });

  test('returns empty for session with no assistant messages', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      { type: 'user.message', id: 'evt-u1', timestamp: '2026-02-27T20:59:09.000Z', parentId: null, data: { content: 'hello' } },
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows).toHaveLength(0);
  });

  test('returns empty for empty events.jsonl', async () => {
    const dir = await createTempSession([]);
    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows).toHaveLength(0);
  });

  test('reads sessionId from workspace.yaml', async () => {
    const workspace = [
      'id: custom-session-id',
      'cwd: /Users/test/myproject',
      'summary: fix login bug',
      'created_at: 2026-02-27T20:58:52Z',
      'updated_at: 2026-02-27T21:00:00Z',
    ].join('\n');

    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage(),
    ], workspace);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.sessionId).toBe('custom-session-id');
    expect(rows[0]!.projectPath).toBe('/Users/test/myproject');
    expect(rows[0]!.sessionName).toBe('fix login bug');
  });

  test('falls back to dir name when no workspace.yaml', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage(),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.sessionId).toBe(path.basename(dir));
  });

  test('sets sessionUpdatedAt from mtimeMs', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage(),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.sessionUpdatedAt).toBe(MTIME);
  });

  test('parses timestamp from event', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage({ timestamp: '2026-02-27T20:59:11.000Z' }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.timestamp).toBe(Date.parse('2026-02-27T20:59:11.000Z'));
  });

  test('uses real token data when usage is present and marks isEstimated false', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage({
        content: 'response',
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 250,
          cache_read_input_tokens: 1200,
          cache_creation_input_tokens: 300,
        },
      }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.tokens.input).toBe(1500);
    expect(rows[0]!.tokens.output).toBe(250);
    expect(rows[0]!.tokens.cacheRead).toBe(1200);
    expect(rows[0]!.tokens.cacheWrite).toBe(300);
    expect(rows[0]!.metadata).toEqual({ isEstimated: false });
  });

  test('omits cache fields when zero in real usage data', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage({
        content: 'response',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.tokens.cacheRead).toBeUndefined();
    expect(rows[0]!.tokens.cacheWrite).toBeUndefined();
  });

  test('prefers event model over resolved model', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeModelChange({ newModel: 'claude-opus-4.6-fast' }),
      makeAssistantMessage({ model: 'gpt-5.1' }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.modelId).toBe('gpt-5.1');
  });

  test('extracts model from tool.execution_complete when no model_change or assistant model', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeToolExecutionComplete({ model: 'gpt-5.3-codex' }),
      makeAssistantMessage(),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.modelId).toBe('gpt-5.3-codex');
  });

  test('model_change events take priority over tool.execution_complete model', async () => {
    const dir = await createTempSession([
      makeSessionStart({ timestamp: '2026-02-27T20:00:00.000Z' }),
      makeToolExecutionComplete({ model: 'gpt-5.3-codex', timestamp: '2026-02-27T20:00:05.000Z' }),
      makeModelChange({ newModel: 'claude-opus-4.6-fast', timestamp: '2026-02-27T20:00:10.000Z' }),
      makeAssistantMessage({ timestamp: '2026-02-27T20:01:00.000Z' }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.modelId).toBe('claude-opus-4.6-fast');
  });

  test('assistant.message data.model takes priority over tool.execution_complete model', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeToolExecutionComplete({ model: 'gpt-5.3-codex' }),
      makeAssistantMessage({ model: 'o4-mini' }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.modelId).toBe('o4-mini');
  });

  test('picks up arbitrary future model names from events without code changes', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      // Simulate a future event type that carries a model field
      {
        type: 'some.future_event',
        id: 'evt-future',
        timestamp: '2026-02-27T20:59:10.000Z',
        parentId: null,
        data: { model: 'gemini-ultra-3-preview', someOtherField: true },
      },
      makeAssistantMessage(),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.modelId).toBe('gemini-ultra-3-preview');
  });

  test('falls back to defaultModel when no event carries a model field', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage(),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.modelId).toBe(DEFAULT_MODEL);
  });

  // -------------------------------------------------------------------------
  // CompactionProcessor-based token estimation
  // -------------------------------------------------------------------------

  test('uses compaction deltas for token estimation when timeline is provided', async () => {
    const dir = await createTempSession([
      makeSessionStart({ timestamp: '2026-02-27T20:58:52.000Z' }),
      makeAssistantMessage({ messageId: 'msg_001', content: 'First', timestamp: '2026-02-27T20:59:00.000Z' }),
      makeAssistantMessage({ messageId: 'msg_002', content: 'Second', timestamp: '2026-02-27T21:00:00.000Z' }),
      makeAssistantMessage({ messageId: 'msg_003', content: 'Third response with more text', timestamp: '2026-02-27T21:01:00.000Z' }),
    ]);

    const compactionTimeline = [
      { timestamp: Date.parse('2026-02-27T20:58:55.000Z'), tokens: 17844, contextWindow: 272000 },
      { timestamp: Date.parse('2026-02-27T20:59:30.000Z'), tokens: 19744, contextWindow: 272000 },
      { timestamp: Date.parse('2026-02-27T21:00:30.000Z'), tokens: 36386, contextWindow: 272000 },
    ];

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL, compactionTimeline);
    expect(rows).toHaveLength(3);

    // Sort by timestamp to match compaction order
    rows.sort((a, b) => a.timestamp - b.timestamp);

    // Message 0: input = CP[0].tokens, output = CP[1] - CP[0]
    expect(rows[0]!.tokens.input).toBe(17844);
    expect(rows[0]!.tokens.output).toBe(19744 - 17844); // 1900

    // Message 1: input = CP[1].tokens, output = CP[2] - CP[1]
    expect(rows[1]!.tokens.input).toBe(19744);
    expect(rows[1]!.tokens.output).toBe(36386 - 19744); // 16642

    // Message 2: input = CP[2].tokens, output = content estimate (no CP[3])
    expect(rows[2]!.tokens.input).toBe(36386);
    expect(rows[2]!.tokens.output).toBe(estimateTokens('Third response with more text'));
  });

  test('compaction data does not override real usage data from assistant.usage', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage({
        content: 'response',
        usage: { prompt_tokens: 5000, completion_tokens: 500 },
      }),
    ]);

    const compactionTimeline = [
      { timestamp: Date.parse('2026-02-27T20:58:55.000Z'), tokens: 17844, contextWindow: 272000 },
    ];

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL, compactionTimeline);
    // Real usage data takes precedence
    expect(rows[0]!.tokens.input).toBe(5000);
    expect(rows[0]!.tokens.output).toBe(500);
  });

  test('falls back to content estimation when no compaction data', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage({ content: 'Hello world response' }),
    ]);

    // No compaction timeline passed
    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL);
    expect(rows[0]!.tokens.output).toBe(estimateTokens('Hello world response'));
    expect(rows[0]!.tokens.input).toBe(Math.ceil(rows[0]!.tokens.output * 0.5));
  });

  test('handles more messages than compaction entries gracefully', async () => {
    const dir = await createTempSession([
      makeSessionStart({ timestamp: '2026-02-27T20:58:52.000Z' }),
      makeAssistantMessage({ messageId: 'msg_001', content: 'First', timestamp: '2026-02-27T20:59:00.000Z' }),
      makeAssistantMessage({ messageId: 'msg_002', content: 'Second reply', timestamp: '2026-02-27T21:00:00.000Z' }),
    ]);

    // Only 1 CP entry for 2 messages
    const compactionTimeline = [
      { timestamp: Date.parse('2026-02-27T20:58:55.000Z'), tokens: 23000, contextWindow: 128000 },
    ];

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL, compactionTimeline);
    rows.sort((a, b) => a.timestamp - b.timestamp);

    // First message gets CP data (input from CP, output = content estimate since no CP[1])
    expect(rows[0]!.tokens.input).toBe(23000);
    expect(rows[0]!.tokens.output).toBe(estimateTokens('First'));

    // Second message keeps content-based estimate (no CP entry for it)
    expect(rows[1]!.tokens.output).toBe(estimateTokens('Second reply'));
    expect(rows[1]!.tokens.input).toBe(Math.ceil(rows[1]!.tokens.output * 0.5));
  });

  test('handles empty compaction timeline same as no timeline', async () => {
    const dir = await createTempSession([
      makeSessionStart(),
      makeAssistantMessage({ content: 'test response' }),
    ]);

    const rows = await parseSessionDirRows(dir, MTIME, DEFAULT_MODEL, []);
    expect(rows[0]!.tokens.output).toBe(estimateTokens('test response'));
    expect(rows[0]!.tokens.input).toBe(Math.ceil(rows[0]!.tokens.output * 0.5));
  });
});

// ---------------------------------------------------------------------------
// parseProcessLogData
// ---------------------------------------------------------------------------

describe('parseProcessLogData', () => {
  test('extracts session ID from Workspace initialized line', () => {
    const content = '2026-03-08T21:52:39.810Z [INFO] Workspace initialized: 65d544b4-d7b2-4cc5-91a4-e545607b6135 (checkpoints: 0)\n';
    const result = parseProcessLogData(content);
    expect(result.sessionId).toBe('65d544b4-d7b2-4cc5-91a4-e545607b6135');
  });

  test('extracts model from Using default model line', () => {
    const content = '2026-02-27T20:33:02.160Z [INFO] Using default model: claude-sonnet-4.6\n';
    const result = parseProcessLogData(content);
    expect(result.model).toBe('claude-sonnet-4.6');
  });

  test('extracts CompactionProcessor timeline entries', () => {
    const content = [
      '2026-03-08T21:52:54.209Z [INFO] CompactionProcessor: Utilization 6.6% (17844/272000 tokens) below threshold 80%',
      '2026-03-08T21:53:01.324Z [INFO] CompactionProcessor: Utilization 7.3% (19744/272000 tokens) below threshold 80%',
      '2026-03-08T21:53:06.343Z [INFO] CompactionProcessor: Utilization 13.4% (36386/272000 tokens) below threshold 80%',
    ].join('\n');

    const result = parseProcessLogData(content);
    expect(result.compactionTimeline).toHaveLength(3);
    expect(result.compactionTimeline[0]).toEqual({
      timestamp: Date.parse('2026-03-08T21:52:54.209Z'),
      tokens: 17844,
      contextWindow: 272000,
    });
    expect(result.compactionTimeline[2]!.tokens).toBe(36386);
  });

  test('parses a complete process log with all fields', () => {
    const content = [
      '2026-03-08T21:52:39.810Z [INFO] Workspace initialized: abcd1234-5678-9012-3456-789012345678 (checkpoints: 0)',
      '2026-03-08T21:52:39.819Z [INFO] Starting Copilot CLI: 0.0.420',
      '2026-03-08T21:52:40.000Z [INFO] Using default model: gpt-5.3-codex',
      '2026-03-08T21:52:54.209Z [INFO] CompactionProcessor: Utilization 6.6% (17844/272000 tokens) below threshold 80%',
      '2026-03-08T21:53:01.324Z [INFO] CompactionProcessor: Utilization 7.3% (19744/272000 tokens) below threshold 80%',
    ].join('\n');

    const result = parseProcessLogData(content);
    expect(result.sessionId).toBe('abcd1234-5678-9012-3456-789012345678');
    expect(result.model).toBe('gpt-5.3-codex');
    expect(result.compactionTimeline).toHaveLength(2);
  });

  test('returns nulls for log without session or model data', () => {
    const content = '2026-03-08T21:52:39.819Z [INFO] Starting Copilot CLI: 0.0.420\n';
    const result = parseProcessLogData(content);
    expect(result.sessionId).toBeNull();
    expect(result.model).toBeNull();
    expect(result.compactionTimeline).toHaveLength(0);
  });

  test('returns last model when multiple Using default model lines exist', () => {
    const content = [
      '2026-02-27T20:33:02.160Z [INFO] Using default model: claude-sonnet-4.6',
      '2026-02-27T20:33:25.853Z [INFO] Using default model: claude-sonnet-4.6',
    ].join('\n');
    const result = parseProcessLogData(content);
    expect(result.model).toBe('claude-sonnet-4.6');
  });
});
