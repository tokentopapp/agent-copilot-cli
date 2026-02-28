import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import type { ActivityCallback, ActivityUpdate } from '@tokentop/plugin-sdk';
import { COPILOT_CLI_SESSION_STATE_PATH, getSessionDirs } from './paths.ts';
import { isAssistantMessage } from './parser.ts';
import { estimateTokens, readWorkspaceYaml, toTimestamp } from './utils.ts';

export interface SessionWatcherState {
  sessionDirWatchers: Map<string, fsSync.FSWatcher>;
  rootWatcher: fsSync.FSWatcher | null;
  dirtyPaths: Set<string>;
  reconciliationTimer: ReturnType<typeof setInterval> | null;
  started: boolean;
}

interface ActivityWatcherState {
  sessionDirWatchers: Map<string, fsSync.FSWatcher>;
  rootWatcher: fsSync.FSWatcher | null;
  callback: ActivityCallback | null;
  fileOffsets: Map<string, number>;
  started: boolean;
}

export const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1000;

export const sessionWatcher: SessionWatcherState = {
  sessionDirWatchers: new Map(),
  rootWatcher: null,
  dirtyPaths: new Set(),
  reconciliationTimer: null,
  started: false,
};

const activityWatcher: ActivityWatcherState = {
  sessionDirWatchers: new Map(),
  rootWatcher: null,
  callback: null,
  fileOffsets: new Map(),
  started: false,
};

export let forceFullReconciliation = false;

function tryWatchNewSessionDir(dirName: string, watchFn: (sessionDirPath: string) => void): void {
  const eventsPath = path.join(COPILOT_CLI_SESSION_STATE_PATH, dirName, 'events.jsonl');
  try {
    if (fsSync.existsSync(eventsPath)) {
      watchFn(path.join(COPILOT_CLI_SESSION_STATE_PATH, dirName));
    }
  } catch {
    // Silently skip inaccessible dirs
  }
}

/**
 * Watch a session directory for activity changes (events.jsonl modifications).
 */
function watchSessionDirForActivity(sessionDirPath: string): void {
  if (activityWatcher.sessionDirWatchers.has(sessionDirPath)) return;

  try {
    const watcher = fsSync.watch(sessionDirPath, (_eventType, filename) => {
      if (filename !== 'events.jsonl') return;
      const filePath = path.join(sessionDirPath, 'events.jsonl');
      void processEventsDelta(filePath, sessionDirPath);
    });

    activityWatcher.sessionDirWatchers.set(sessionDirPath, watcher);
  } catch {
    // Silently skip unwatchable dirs
  }
}

/**
 * Prime file offsets for existing events.jsonl files.
 * Called when starting activity watching so we only emit deltas for new events.
 */
async function primeSessionOffset(sessionDirPath: string): Promise<void> {
  const eventsPath = path.join(sessionDirPath, 'events.jsonl');
  try {
    const stat = await fs.stat(eventsPath);
    activityWatcher.fileOffsets.set(eventsPath, stat.size);
  } catch {
    // File might not exist yet
  }
}

/**
 * Process only the new bytes appended to events.jsonl since we last read.
 * Emits ActivityUpdate for each new assistant.message event.
 */
async function processEventsDelta(filePath: string, sessionDirPath: string): Promise<void> {
  const callback = activityWatcher.callback;
  if (!callback) return;

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch {
    activityWatcher.fileOffsets.delete(filePath);
    return;
  }

  const knownOffset = activityWatcher.fileOffsets.get(filePath) ?? 0;
  const startOffset = stat.size < knownOffset ? 0 : knownOffset;

  if (stat.size === startOffset) return;

  let chunk: string;
  try {
    const handle = await fs.open(filePath, 'r');
    const length = stat.size - startOffset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, startOffset);
    await handle.close();
    chunk = buffer.toString('utf-8');
  } catch {
    return;
  }

  activityWatcher.fileOffsets.set(filePath, stat.size);

  // Get session ID from directory name or workspace.yaml
  const workspace = await readWorkspaceYaml(path.join(sessionDirPath, 'workspace.yaml'));
  const sessionId = workspace?.id ?? path.basename(sessionDirPath);

  const lines = chunk.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }

    if (!isAssistantMessage(event)) continue;

    const { data } = event;

    let inputTokens: number;
    let outputTokens: number;

    if (data.usage && typeof data.usage.prompt_tokens === 'number' && data.usage.prompt_tokens > 0) {
      inputTokens = data.usage.prompt_tokens;
      outputTokens = data.usage.completion_tokens ?? 0;
    } else {
      outputTokens = estimateTokens(data.content);
      inputTokens = Math.ceil(outputTokens * 0.5);
    }

    const tokens: ActivityUpdate['tokens'] = {
      input: inputTokens,
      output: outputTokens,
    };

    if (data.usage?.cache_read_input_tokens && data.usage.cache_read_input_tokens > 0) {
      tokens.cacheRead = data.usage.cache_read_input_tokens;
    }
    if (data.usage?.cache_creation_input_tokens && data.usage.cache_creation_input_tokens > 0) {
      tokens.cacheWrite = data.usage.cache_creation_input_tokens;
    }

    callback({
      sessionId,
      messageId: data.messageId,
      tokens,
      timestamp: toTimestamp(event.timestamp, Date.now()),
    });
  }
}

/**
 * Watch a session directory for dirty tracking (marks events.jsonl as dirty for next parseSessions call).
 */
export function watchSessionDir(sessionDirPath: string): void {
  if (sessionWatcher.sessionDirWatchers.has(sessionDirPath)) return;

  try {
    const watcher = fsSync.watch(sessionDirPath, (_eventType, filename) => {
      if (filename === 'events.jsonl') {
        const filePath = path.join(sessionDirPath, 'events.jsonl');
        sessionWatcher.dirtyPaths.add(filePath);
      }
    });
    sessionWatcher.sessionDirWatchers.set(sessionDirPath, watcher);
  } catch {
    // Silently skip unwatchable dirs
  }
}

export function startSessionWatcher(): void {
  if (sessionWatcher.started) return;
  sessionWatcher.started = true;

  try {
    sessionWatcher.rootWatcher = fsSync.watch(COPILOT_CLI_SESSION_STATE_PATH, (eventType, filename) => {
      if (eventType !== 'rename' || !filename) return;
      tryWatchNewSessionDir(filename, watchSessionDir);
    });
  } catch {
    // Session state dir might not exist yet
  }

  void getSessionDirs().then((dirs) => {
    for (const dirPath of dirs) {
      watchSessionDir(dirPath);
    }
  });

  sessionWatcher.reconciliationTimer = setInterval(() => {
    forceFullReconciliation = true;
  }, RECONCILIATION_INTERVAL_MS);
}

export function stopSessionWatcher(): void {
  if (sessionWatcher.reconciliationTimer) {
    clearInterval(sessionWatcher.reconciliationTimer);
    sessionWatcher.reconciliationTimer = null;
  }

  for (const watcher of sessionWatcher.sessionDirWatchers.values()) {
    watcher.close();
  }
  sessionWatcher.sessionDirWatchers.clear();

  if (sessionWatcher.rootWatcher) {
    sessionWatcher.rootWatcher.close();
    sessionWatcher.rootWatcher = null;
  }

  sessionWatcher.dirtyPaths.clear();
  sessionWatcher.started = false;
}

export function consumeForceFullReconciliation(): boolean {
  const value = forceFullReconciliation;
  if (forceFullReconciliation) {
    forceFullReconciliation = false;
  }
  return value;
}

export function startActivityWatch(callback: ActivityCallback): void {
  activityWatcher.callback = callback;

  if (activityWatcher.started) return;
  activityWatcher.started = true;

  try {
    activityWatcher.rootWatcher = fsSync.watch(COPILOT_CLI_SESSION_STATE_PATH, (eventType, filename) => {
      if (eventType !== 'rename' || !filename) return;

      const sessionDirPath = path.join(COPILOT_CLI_SESSION_STATE_PATH, filename);
      watchSessionDirForActivity(sessionDirPath);
      void primeSessionOffset(sessionDirPath);
    });
  } catch {
    // Session state dir might not exist yet
  }

  void getSessionDirs().then((dirs) => {
    for (const dirPath of dirs) {
      watchSessionDirForActivity(dirPath);
      void primeSessionOffset(dirPath);
    }
  });
}

export function stopActivityWatch(): void {
  for (const watcher of activityWatcher.sessionDirWatchers.values()) {
    watcher.close();
  }
  activityWatcher.sessionDirWatchers.clear();

  if (activityWatcher.rootWatcher) {
    activityWatcher.rootWatcher.close();
    activityWatcher.rootWatcher = null;
  }

  activityWatcher.fileOffsets.clear();
  activityWatcher.callback = null;
  activityWatcher.started = false;

  stopSessionWatcher();
}
