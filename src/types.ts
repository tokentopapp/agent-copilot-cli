import type { SessionUsageData } from '@tokentop/plugin-sdk';

// ---------------------------------------------------------------------------
// Event envelope — every line in events.jsonl has this shape
// ---------------------------------------------------------------------------

export interface CopilotCliEventBase {
  type: string;
  data: unknown;
  id: string;
  timestamp: string;
  parentId: string | null;
}

// ---------------------------------------------------------------------------
// session.start
// ---------------------------------------------------------------------------

export interface CopilotCliSessionStartData {
  sessionId: string;
  version: number;
  producer: string;
  copilotVersion: string;
  startTime: string;
  context: {
    cwd: string;
    gitRoot?: string;
    branch?: string;
    repository?: string;
  };
}

export interface CopilotCliSessionStartEvent {
  type: 'session.start';
  data: CopilotCliSessionStartData;
  id: string;
  timestamp: string;
  parentId: string | null;
}

// ---------------------------------------------------------------------------
// session.model_change
// ---------------------------------------------------------------------------

export interface CopilotCliSessionModelChangeData {
  previousModel?: string;
  newModel: string;
}

export interface CopilotCliSessionModelChangeEvent {
  type: 'session.model_change';
  data: CopilotCliSessionModelChangeData;
  id: string;
  timestamp: string;
  parentId: string | null;
}

// ---------------------------------------------------------------------------
// user.message
// ---------------------------------------------------------------------------

export interface CopilotCliUserMessageData {
  content: string;
  transformedContent?: string;
  attachments?: unknown[];
  interactionId: string;
}

export interface CopilotCliUserMessageEvent {
  type: 'user.message';
  data: CopilotCliUserMessageData;
  id: string;
  timestamp: string;
  parentId: string | null;
}

// ---------------------------------------------------------------------------
// assistant.turn_start / assistant.turn_end
// ---------------------------------------------------------------------------

export interface CopilotCliTurnStartData {
  turnId: string;
  interactionId: string;
}

export interface CopilotCliTurnStartEvent {
  type: 'assistant.turn_start';
  data: CopilotCliTurnStartData;
  id: string;
  timestamp: string;
  parentId: string | null;
}

export interface CopilotCliTurnEndData {
  turnId: string;
}

export interface CopilotCliTurnEndEvent {
  type: 'assistant.turn_end';
  data: CopilotCliTurnEndData;
  id: string;
  timestamp: string;
  parentId: string | null;
}

// ---------------------------------------------------------------------------
// assistant.message — the primary event carrying content
// ---------------------------------------------------------------------------

export interface CopilotCliAssistantMessageData {
  messageId: string;
  content: string;
  toolRequests?: unknown[];
  interactionId: string;
  reasoningOpaque?: string;
  reasoningText?: string;
  /** Token usage — present in newer Copilot CLI versions. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cached_tokens?: number;
    total_tokens?: number;
  };
  /** Model used for this response — present in newer versions. */
  model?: string;
}

export interface CopilotCliAssistantMessageEvent {
  type: 'assistant.message';
  data: CopilotCliAssistantMessageData;
  id: string;
  timestamp: string;
  parentId: string | null;
}

// ---------------------------------------------------------------------------
// Union of all known event types
// ---------------------------------------------------------------------------

export type CopilotCliEvent =
  | CopilotCliSessionStartEvent
  | CopilotCliSessionModelChangeEvent
  | CopilotCliUserMessageEvent
  | CopilotCliTurnStartEvent
  | CopilotCliTurnEndEvent
  | CopilotCliAssistantMessageEvent
  | CopilotCliEventBase; // catch-all for unknown event types

// ---------------------------------------------------------------------------
// workspace.yaml shape (parsed to object)
// ---------------------------------------------------------------------------

export interface CopilotCliWorkspaceInfo {
  id: string;
  cwd: string;
  git_root?: string;
  repository?: string;
  branch?: string;
  summary?: string;
  summary_count?: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

export interface SessionAggregateCacheEntry {
  updatedAt: number;
  usageRows: SessionUsageData[];
  lastAccessed: number;
}
