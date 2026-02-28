import * as fs from 'fs';
import {
  createAgentPlugin,
  type AgentFetchContext,
  type PluginContext,
  type SessionParseOptions,
  type SessionUsageData,
} from '@tokentop/plugin-sdk';
import { CACHE_TTL_MS, SESSION_AGGREGATE_CACHE_MAX, sessionAggregateCache, sessionCache, sessionMetadataIndex } from './cache.ts';
import { parseSessionsFromDirs } from './parser.ts';
import { COPILOT_CLI_HOME, COPILOT_CLI_SESSION_STATE_PATH } from './paths.ts';
import { RECONCILIATION_INTERVAL_MS, startActivityWatch, stopActivityWatch } from './watcher.ts';

const copilotCliAgentPlugin = createAgentPlugin({
  id: 'copilot-cli',
  type: 'agent',
  name: 'Copilot CLI',
  version: '0.1.0',

  meta: {
    description: 'GitHub Copilot CLI session tracking',
    homepage: 'https://githubnext.com/projects/copilot-cli',
  },

  permissions: {
    filesystem: {
      read: true,
      paths: ['~/.copilot'],
    },
  },

  agent: {
    name: 'Copilot CLI',
    command: 'gh copilot',
    configPath: COPILOT_CLI_HOME,
    sessionPath: COPILOT_CLI_SESSION_STATE_PATH,
  },

  capabilities: {
    sessionParsing: true,
    authReading: false,
    realTimeTracking: true,
    multiProvider: false,
  },

  startActivityWatch(_ctx: PluginContext, callback): void {
    startActivityWatch(callback);
  },

  stopActivityWatch(_ctx: PluginContext): void {
    stopActivityWatch();
  },

  async isInstalled(_ctx: PluginContext): Promise<boolean> {
    return fs.existsSync(COPILOT_CLI_SESSION_STATE_PATH) || fs.existsSync(COPILOT_CLI_HOME);
  },

  async parseSessions(options: SessionParseOptions, ctx: AgentFetchContext): Promise<SessionUsageData[]> {
    return parseSessionsFromDirs(options, ctx);
  },
});

export {
  CACHE_TTL_MS,
  COPILOT_CLI_HOME,
  COPILOT_CLI_SESSION_STATE_PATH,
  RECONCILIATION_INTERVAL_MS,
  SESSION_AGGREGATE_CACHE_MAX,
  sessionAggregateCache,
  sessionCache,
  sessionMetadataIndex,
};

export default copilotCliAgentPlugin;
