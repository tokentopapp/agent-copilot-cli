import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const COPILOT_CLI_HOME = path.join(os.homedir(), '.copilot');
export const COPILOT_CLI_SESSION_STATE_PATH = path.join(COPILOT_CLI_HOME, 'session-state');
export const COPILOT_CLI_LOGS_PATH = path.join(COPILOT_CLI_HOME, 'logs');

/**
 * Discover all session directories under `~/.copilot/session-state/`.
 * Each session is a directory named by UUID containing `events.jsonl` and `workspace.yaml`.
 */
export async function getSessionDirs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(COPILOT_CLI_SESSION_STATE_PATH, { withFileTypes: true });
    const dirs: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const eventsPath = path.join(COPILOT_CLI_SESSION_STATE_PATH, entry.name, 'events.jsonl');
      try {
        await fs.access(eventsPath);
        dirs.push(path.join(COPILOT_CLI_SESSION_STATE_PATH, entry.name));
      } catch {
        // Session dir without events.jsonl — skip
      }
    }

    return dirs;
  } catch {
    return [];
  }
}

/**
 * Find the most recent process log file in `~/.copilot/logs/`.
 * Process logs contain model information and utilization data.
 */
export async function getLatestProcessLog(): Promise<string | null> {
  try {
    const entries = await fs.readdir(COPILOT_CLI_LOGS_PATH, { withFileTypes: true });
    const logFiles: Array<{ name: string; mtimeMs: number }> = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('process-') || !entry.name.endsWith('.log')) continue;

      try {
        const stat = await fs.stat(path.join(COPILOT_CLI_LOGS_PATH, entry.name));
        logFiles.push({ name: entry.name, mtimeMs: stat.mtimeMs });
      } catch {
        // Skip files we can't stat
      }
    }

    if (logFiles.length === 0) return null;

    logFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return path.join(COPILOT_CLI_LOGS_PATH, logFiles[0]!.name);
  } catch {
    return null;
  }
}
