// Hand-shim for the task-orchestrator dispatcher entrypoint so checkJs does
// not recurse into the dependency's compiled lib/ JS (which is built without
// checkJs in mind). Types here cover ONLY what the integration package uses.
declare module 'dsh-task-orchestrator/dispatcher' {
  export interface WorkerRequest {
    /** @type {any} */ task?: object;
    /** @type {any} */ spec?: object;
    /** @type {any} */ selection?: string;
    /** @type {any} */ runId?: string;
  }
  export interface LauncherHandle {
    sessionId?: string;
    pid?: number | null;
    wait?: () => Promise<any>;
    terminate?: (signal?: string) => Promise<boolean>;
  }
  export function createWorkerLauncher(options?: Record<string, unknown>): { launch(input: WorkerRequest): Promise<LauncherHandle> };
  export const WorkerDispatchError: new (message: string, code?: string, details?: unknown) => Error;
  export class WorkerDispatcher {
    constructor(options?: Record<string, unknown>);
    dispatchOnce(request: { workerProfile: string; limit?: number }): Promise<any>;
    dispatchTask(task: { id: string; [k: string]: unknown }): Promise<any>;
    releaseOrRevert(taskId: string, worker: string): 'released' | 'reverted' | 'held_by_other' | 'failed';
  }
}
