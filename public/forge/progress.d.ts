export type ProgressOptions = { key?: string; label?: string; detail?: string; value?: number; total?: number; status?: 'running' | 'done' | 'error'; startedAt?: number; finishedAt?: number; retain?: boolean; compact?: boolean; action?: () => void; actionLabel?: string };
export type ProgressTask = { update(patch: ProgressOptions): void; attach(element: Element | null): void; done(detail?: string, action?: () => void): void; fail(detail: string): void; dismiss(): void };
export function elapsed(since: number, until?: number): string;
export function progressHtml(options?: ProgressOptions): string;
export function startTask(label: string, options?: ProgressOptions): ProgressTask;
export function withProgress<T>(label: string, work: (task: ProgressTask) => Promise<T>, options?: ProgressOptions): Promise<T>;
