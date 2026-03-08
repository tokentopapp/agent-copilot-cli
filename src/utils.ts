import * as fs from 'fs/promises';
import type { CopilotCliWorkspaceInfo, ProcessLogData } from './types.ts';

/**
 * Read a JSONL file and return an array of parsed lines.
 * Silently skips malformed lines and returns empty on file errors.
 */
export async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const rows: T[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        rows.push(JSON.parse(trimmed) as T);
      } catch {
        // Skip malformed lines
      }
    }

    return rows;
  } catch {
    return [];
  }
}

/**
 * Parse a simple YAML file into a flat key-value object.
 * Handles the workspace.yaml format used by Copilot CLI:
 *   key: value
 * Does NOT handle nested YAML, arrays, or multi-line values.
 */
export async function readWorkspaceYaml(filePath: string): Promise<CopilotCliWorkspaceInfo | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const result: Record<string, string> = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;

      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();
      if (key) {
        result[key] = value;
      }
    }

    if (!result['id']) return null;

    return {
      id: result['id']!,
      cwd: result['cwd'] ?? '',
      git_root: result['git_root'],
      repository: result['repository'],
      branch: result['branch'],
      summary: result['summary'],
      summary_count: result['summary_count'] ? parseInt(result['summary_count'], 10) : undefined,
      created_at: result['created_at'] ?? '',
      updated_at: result['updated_at'] ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * Estimate token count from text content.
 * Uses the standard ~4 characters per token heuristic.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Extract the default model name from a Copilot CLI process log file.
 * Scans for lines like: `[INFO] Using default model: claude-sonnet-4.6`
 * Returns the last match (most recent model selection).
 */
export async function extractModelFromProcessLog(logPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(logPath, 'utf-8');
    const matches = content.matchAll(/\[INFO\] Using default model: (.+)/g);
    let lastModel: string | null = null;

    for (const match of matches) {
      const model = match[1]?.trim();
      if (model) {
        lastModel = model;
      }
    }

    return lastModel;
  } catch {
    return null;
  }
}

export function toTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const RE_WORKSPACE_INIT = /Workspace initialized: ([0-9a-f-]{36})/;
const RE_DEFAULT_MODEL = /\[INFO\] Using default model: (.+)/;
const RE_COMPACTION = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[INFO\] CompactionProcessor: Utilization [\d.]+% \((\d+)\/(\d+) tokens\)/;

/**
 * Parse a Copilot CLI process log file and extract session ID, model, and
 * CompactionProcessor timeline. Pure function — no I/O.
 */
export function parseProcessLogData(content: string): ProcessLogData {
  const lines = content.split(/\r?\n/);
  let sessionId: string | null = null;
  let model: string | null = null;
  const compactionTimeline: ProcessLogData['compactionTimeline'] = [];

  for (const line of lines) {
    if (!sessionId) {
      const wsMatch = RE_WORKSPACE_INIT.exec(line);
      if (wsMatch) {
        sessionId = wsMatch[1]!;
      }
    }

    const modelMatch = RE_DEFAULT_MODEL.exec(line);
    if (modelMatch) {
      model = modelMatch[1]!.trim();
    }

    const cpMatch = RE_COMPACTION.exec(line);
    if (cpMatch) {
      const ts = Date.parse(cpMatch[1]!);
      if (Number.isFinite(ts)) {
        compactionTimeline.push({
          timestamp: ts,
          tokens: parseInt(cpMatch[2]!, 10),
          contextWindow: parseInt(cpMatch[3]!, 10),
        });
      }
    }
  }

  return { sessionId, model, compactionTimeline };
}
