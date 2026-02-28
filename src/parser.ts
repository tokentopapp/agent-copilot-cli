import * as fs from 'fs/promises';
import * as path from 'path';
import type { AgentFetchContext, SessionParseOptions, SessionUsageData } from '@tokentop/plugin-sdk';
import { CACHE_TTL_MS, evictSessionAggregateCache, sessionAggregateCache, sessionCache, sessionMetadataIndex } from './cache.ts';
import { COPILOT_CLI_LOGS_PATH, COPILOT_CLI_SESSION_STATE_PATH, getSessionDirs } from './paths.ts';
import type { CopilotCliAssistantMessageEvent, CopilotCliEventBase, CopilotCliSessionModelChangeEvent, CopilotCliSessionStartEvent } from './types.ts';
import { estimateTokens, extractModelFromProcessLog, readJsonlFile, readWorkspaceYaml, toTimestamp } from './utils.ts';
import {
  consumeForceFullReconciliation,
  sessionWatcher,
  startSessionWatcher,
  watchSessionDir,
} from './watcher.ts';

interface ParsedSessionDir {
  sessionId: string;
  dirPath: string;
  mtimeMs: number;
}

/** Cached model name from the most recent process log. */
let cachedModel: string | null = null;
let modelCacheTime = 0;
const MODEL_CACHE_TTL_MS = 60_000;

/**
 * Get the default model from process logs, with 60s caching.
 */
async function getDefaultModel(): Promise<string> {
  const now = Date.now();
  if (cachedModel && now - modelCacheTime < MODEL_CACHE_TTL_MS) {
    return cachedModel;
  }

  try {
    const entries = await fs.readdir(COPILOT_CLI_LOGS_PATH, { withFileTypes: true });
    const logFiles: Array<{ name: string; mtimeMs: number }> = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('process-') || !entry.name.endsWith('.log')) continue;
      try {
        const stat = await fs.stat(path.join(COPILOT_CLI_LOGS_PATH, entry.name));
        logFiles.push({ name: entry.name, mtimeMs: stat.mtimeMs });
      } catch {
        // Skip unreadable files
      }
    }

    if (logFiles.length > 0) {
      logFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const latestLog = path.join(COPILOT_CLI_LOGS_PATH, logFiles[0]!.name);
      const model = await extractModelFromProcessLog(latestLog);
      if (model) {
        cachedModel = model;
        modelCacheTime = now;
        return model;
      }
    }
  } catch {
    // Fall through to default
  }

  return cachedModel ?? 'unknown';
}

/**
 * Resolve which model was active at a given timestamp.
 * Walks the model change timeline backwards — the most recent change before
 * (or at) the timestamp wins. Falls back to defaultModel if the message
 * predates all model changes.
 */
function resolveModelAtTime(
  timestamp: number,
  defaultModel: string,
  modelChanges: ReadonlyArray<{ timestamp: number; model: string }>,
): string {
  if (modelChanges.length === 0) return defaultModel;

  // Walk backwards to find the last change at or before this timestamp
  for (let i = modelChanges.length - 1; i >= 0; i--) {
    if (modelChanges[i]!.timestamp <= timestamp) {
      return modelChanges[i]!.model;
    }
  }

  return defaultModel;
}

/**
 * Type guard: check if an event is an assistant.message with content.
 */
export function isAssistantMessage(event: unknown): event is CopilotCliAssistantMessageEvent {
  if (!event || typeof event !== 'object') return false;

  const candidate = event as Partial<CopilotCliEventBase>;
  if (candidate.type !== 'assistant.message') return false;

  const data = candidate.data as Partial<CopilotCliAssistantMessageEvent['data']> | undefined;
  if (!data || typeof data !== 'object') return false;
  if (typeof data.messageId !== 'string' || data.messageId.length === 0) return false;
  if (typeof data.content !== 'string') return false;

  return true;
}

/**
 * Type guard: check if an event is a session.start.
 */
export function isSessionStart(event: unknown): event is CopilotCliSessionStartEvent {
  if (!event || typeof event !== 'object') return false;

  const candidate = event as Partial<CopilotCliEventBase>;
  if (candidate.type !== 'session.start') return false;

  const data = candidate.data as Partial<CopilotCliSessionStartEvent['data']> | undefined;
  if (!data || typeof data !== 'object') return false;
  if (typeof data.sessionId !== 'string') return false;

  return true;
}

/**
 * Type guard: check if an event is a session.model_change.
 */
export function isModelChange(event: unknown): event is CopilotCliSessionModelChangeEvent {
  if (!event || typeof event !== 'object') return false;

  const candidate = event as Partial<CopilotCliEventBase>;
  if (candidate.type !== 'session.model_change') return false;

  const data = candidate.data as Partial<CopilotCliSessionModelChangeEvent['data']> | undefined;
  if (!data || typeof data !== 'object') return false;
  if (typeof data.newModel !== 'string' || data.newModel.length === 0) return false;

  return true;
}

/**
 * Parse a single session directory's events.jsonl + workspace.yaml into SessionUsageData rows.
 */
export async function parseSessionDirRows(
  dirPath: string,
  mtimeMs: number,
  defaultModel: string,
): Promise<SessionUsageData[]> {
  const eventsPath = path.join(dirPath, 'events.jsonl');
  const workspacePath = path.join(dirPath, 'workspace.yaml');

  const events = await readJsonlFile<CopilotCliEventBase>(eventsPath);
  if (events.length === 0) return [];

  const workspace = await readWorkspaceYaml(workspacePath);
  const sessionId = workspace?.id ?? path.basename(dirPath);
  const projectPath = workspace?.cwd || undefined;
  const sessionName = workspace?.summary?.trim() || undefined;

  const deduped = new Map<string, SessionUsageData>();

  // Build model timeline from session.model_change events so each message
  // gets the model that was active at its timestamp (like OpenCode's per-message modelId).
  const modelChanges: Array<{ timestamp: number; model: string }> = [];
  for (const event of events) {
    if (isModelChange(event)) {
      modelChanges.push({
        timestamp: toTimestamp(event.timestamp, 0),
        model: event.data.newModel,
      });
    }
  }
  // Sort ascending by time so binary-style lookup works
  modelChanges.sort((a, b) => a.timestamp - b.timestamp);

  // Process assistant messages
  for (const event of events) {
    if (!isAssistantMessage(event)) continue;

    const { data } = event;

    // Prefer real token data if present (future-proofing for when assistant.usage events are persisted)
    let inputTokens: number;
    let outputTokens: number;
    let cacheRead: number | undefined;
    let cacheWrite: number | undefined;
    let isEstimated = true;

    if (data.usage && typeof data.usage.prompt_tokens === 'number' && data.usage.prompt_tokens > 0) {
      inputTokens = data.usage.prompt_tokens;
      outputTokens = data.usage.completion_tokens ?? 0;
      isEstimated = false;
      if (data.usage.cache_read_input_tokens && data.usage.cache_read_input_tokens > 0) {
        cacheRead = data.usage.cache_read_input_tokens;
      }
      if (data.usage.cache_creation_input_tokens && data.usage.cache_creation_input_tokens > 0) {
        cacheWrite = data.usage.cache_creation_input_tokens;
      }
    } else {
      // Estimate tokens from content length (~4 chars per token)
      outputTokens = estimateTokens(data.content);
      // Estimate input as a fraction of output — assistant messages don't carry input context,
      // but each turn typically has comparable input/output. Use a conservative estimate.
      inputTokens = Math.ceil(outputTokens * 0.5);
    }

    const modelId = data.model ?? resolveModelAtTime(toTimestamp(event.timestamp, mtimeMs), defaultModel, modelChanges);

    const usage: SessionUsageData = {
      sessionId,
      providerId: 'github-copilot',
      modelId,
      tokens: {
        input: inputTokens,
        output: outputTokens,
      },
      timestamp: toTimestamp(event.timestamp, mtimeMs),
      sessionUpdatedAt: mtimeMs,
      metadata: { isEstimated },
    };

    if (sessionName) {
      usage.sessionName = sessionName;
    }
    if (cacheRead) {
      usage.tokens.cacheRead = cacheRead;
    }
    if (cacheWrite) {
      usage.tokens.cacheWrite = cacheWrite;
    }
    if (projectPath) {
      usage.projectPath = projectPath;
    }

    deduped.set(data.messageId, usage);
  }

  return Array.from(deduped.values());
}

/**
 * Main entry point: parse all Copilot CLI sessions from `~/.copilot/session-state/`.
 */
export async function parseSessionsFromDirs(
  options: SessionParseOptions,
  ctx: AgentFetchContext,
): Promise<SessionUsageData[]> {
  const limit = options.limit ?? 100;
  const since = options.since;

  try {
    await fs.access(COPILOT_CLI_SESSION_STATE_PATH);
  } catch {
    ctx.logger.debug('No Copilot CLI session-state directory found');
    return [];
  }

  startSessionWatcher();

  const now = Date.now();
  if (
    !options.sessionId &&
    limit === sessionCache.lastLimit &&
    now - sessionCache.lastCheck < CACHE_TTL_MS &&
    sessionCache.lastResult.length > 0 &&
    sessionCache.lastSince === since
  ) {
    ctx.logger.debug('Copilot CLI: using cached sessions (within TTL)', { count: sessionCache.lastResult.length });
    return sessionCache.lastResult;
  }

  const dirtyPaths = new Set(sessionWatcher.dirtyPaths);
  sessionWatcher.dirtyPaths.clear();

  const needsFullStat = consumeForceFullReconciliation();
  if (needsFullStat) {
    ctx.logger.debug('Copilot CLI: full reconciliation sweep triggered');
  }

  const sessionDirs: ParsedSessionDir[] = [];
  const seenDirPaths = new Set<string>();

  let statCount = 0;
  let statSkipCount = 0;
  let dirtyHitCount = 0;

  const discoveredDirs = await getSessionDirs();
  const defaultModel = await getDefaultModel();

  for (const sessionDirPath of discoveredDirs) {
    watchSessionDir(sessionDirPath);

    const eventsPath = path.join(sessionDirPath, 'events.jsonl');
    seenDirPaths.add(eventsPath);

    const isDirty = dirtyPaths.has(eventsPath);
    if (isDirty) dirtyHitCount++;

    const metadata = sessionMetadataIndex.get(eventsPath);

    if (options.sessionId && metadata && metadata.sessionId !== options.sessionId) continue;

    if (!isDirty && !needsFullStat && metadata) {
      statSkipCount++;

      if (!since || metadata.mtimeMs >= since) {
        sessionDirs.push({
          sessionId: metadata.sessionId,
          dirPath: sessionDirPath,
          mtimeMs: metadata.mtimeMs,
        });
      }
      continue;
    }

    statCount++;
    let mtimeMs: number;
    try {
      const stat = await fs.stat(eventsPath);
      mtimeMs = stat.mtimeMs;
    } catch {
      sessionMetadataIndex.delete(eventsPath);
      continue;
    }

    if (metadata && metadata.mtimeMs === mtimeMs) {
      if (options.sessionId && metadata.sessionId !== options.sessionId) continue;

      if (!since || metadata.mtimeMs >= since) {
        sessionDirs.push({
          sessionId: metadata.sessionId,
          dirPath: sessionDirPath,
          mtimeMs: metadata.mtimeMs,
        });
      }
      continue;
    }

    // Need to read the session ID from workspace.yaml or dir name
    const sessionId = path.basename(sessionDirPath);
    sessionMetadataIndex.set(eventsPath, { mtimeMs, sessionId });

    if (options.sessionId && sessionId !== options.sessionId) continue;

    if (!since || mtimeMs >= since) {
      sessionDirs.push({ sessionId, dirPath: sessionDirPath, mtimeMs });
    }
  }

  // Prune stale metadata entries
  for (const cachedPath of sessionMetadataIndex.keys()) {
    if (!seenDirPaths.has(cachedPath)) {
      sessionMetadataIndex.delete(cachedPath);
    }
  }

  sessionDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions: SessionUsageData[] = [];
  let aggregateCacheHits = 0;
  let aggregateCacheMisses = 0;

  for (const dir of sessionDirs) {
    const cached = sessionAggregateCache.get(dir.sessionId);
    if (cached && cached.updatedAt === dir.mtimeMs) {
      cached.lastAccessed = now;
      aggregateCacheHits++;
      sessions.push(...cached.usageRows);
      continue;
    }

    aggregateCacheMisses++;

    const usageRows = await parseSessionDirRows(dir.dirPath, dir.mtimeMs, defaultModel);

    sessionAggregateCache.set(dir.sessionId, {
      updatedAt: dir.mtimeMs,
      usageRows,
      lastAccessed: now,
    });

    sessions.push(...usageRows);
  }

  evictSessionAggregateCache();

  if (!options.sessionId) {
    sessionCache.lastCheck = Date.now();
    sessionCache.lastResult = sessions;
    sessionCache.lastLimit = limit;
    sessionCache.lastSince = since;
  }

  ctx.logger.debug('Copilot CLI: parsed sessions', {
    count: sessions.length,
    sessionDirs: sessionDirs.length,
    statChecks: statCount,
    statSkips: statSkipCount,
    dirtyHits: dirtyHitCount,
    aggregateCacheHits,
    aggregateCacheMisses,
    metadataIndexSize: sessionMetadataIndex.size,
    aggregateCacheSize: sessionAggregateCache.size,
    defaultModel,
  });

  return sessions;
}
