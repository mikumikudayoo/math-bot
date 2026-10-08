import type { Store } from './store.js';
import { UserError, type Job, type Result } from './types.js';
import { ProviderBackoff } from './providers.js';
export interface QueueConfig { concurrency: number; reserved: number; borrow: boolean; timeoutMs: number }
export type Runner = (job: Job, signal: AbortSignal, status: (message: string) => void) => Promise<Result>;
export class Scheduler {
  active = new Map<string, {job: Job; controller: AbortController}>();
  stopped = false;
  private wake:ReturnType<typeof setTimeout>|undefined;
  private readonly poll:ReturnType<typeof setInterval>;
  constructor(readonly store: Store, readonly config: QueueConfig, readonly run: Runner) {
    if (config.concurrency < 1 || config.reserved < 0 || config.reserved >= config.concurrency) throw new Error('Reserved capacity must be below total concurrency.');
    this.poll=setInterval(()=>this.tick(),1000);this.poll.unref();
  }
  tick() {
    if (this.stopped) return;
    while (this.active.size < this.config.concurrency) {
      const normals = [...this.active.values()].filter(x => !x.job.coach).length;
      const job = this.store.queued().find(job =>
        ![...this.active.values()].some(x => x.job.user === job.user && x.job.guild === job.guild) &&
        (job.coach || this.config.borrow || normals < this.config.concurrency-this.config.reserved));
      if (!job) break;
      const controller = new AbortController();
      this.active.set(job.id, {job, controller}); this.store.running(job.id);
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      Promise.resolve().then(() => this.run(job, controller.signal, status => this.store.status(job.id,status)))
        .then(result => {
          if (this.stopped) this.store.requeue(job.id);
          else if (controller.signal.aborted) this.store.fail(job.id, 'Request timed out. Please try a shorter question.');
          else this.store.complete(job.id,result);
        })
        .catch(error => {
          if(this.stopped)this.store.requeue(job.id);
          else if(error instanceof ProviderBackoff && Date.now()-job.created<86400000){this.store.defer(job.id,error.retryAt);if(!this.wake)this.wake=setTimeout(()=>{this.wake=undefined;this.tick();},Math.max(1000,Math.min(error.retryAt-Date.now(),60000)));}
          else this.store.fail(job.id, error instanceof UserError ? error.message : controller.signal.aborted ? 'Request timed out.' : 'The AI or tool failed. Please try again.');
        })
        .finally(() => { clearTimeout(timeout); this.active.delete(job.id); this.tick(); });
    }
  }
  cancel(id: string) { this.store.cancel(id); this.active.get(id)?.controller.abort(); this.tick(); }
  stop() { this.stopped = true;clearInterval(this.poll);if(this.wake)clearTimeout(this.wake); for (const x of this.active.values()) x.controller.abort(); }
}
