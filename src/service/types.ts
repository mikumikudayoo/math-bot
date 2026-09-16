export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type JobKind = 'ask' | 'calculate' | 'plot' | 'python';
export interface Submission {
  discordContext?: string;
  id: string; guild: string; channel: string; user: string; coach: boolean;
  kind: JobKind; prompt: string; parent?: string; image?: string;
}
export interface Job extends Submission {
  state: JobState; status: string; answer: string; artifact: string;
  created: number; message: string; delivered: number;
}
export class UserError extends Error {}
export interface Result { answer: string; artifact?: string }
