export type State = 'queued' | 'transcribing' | 'dispatching' | 'working' | 'done' | 'needs_attention' | 'uncertain' | 'failed';
export interface Target {
  id: string;
  name: string;
  provider: 'herdr' | 'grok' | 'dot';
  detail: string;
  status: string;
  available: boolean;
  pane?: string;
  identity?: string;
  kind?: string;
  project?: string;
  character?: 'grok' | 'codex' | 'claude' | 'pi' | 'dot';
  session?: string;
  cwd?: string;
  sessionPath?: string;
}
export interface Turn {
  id: string;
  target: Target;
  state: State;
  text: string;
  reply: string;
  output: string;
  error: string;
  created: number;
  updated: number;
}
export class UserError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}
