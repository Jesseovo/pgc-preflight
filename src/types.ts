export type Status = 'pass' | 'issue' | 'review';
export type Category = 'file' | 'load' | 'runtime' | 'input' | 'layout' | 'flow';
export interface Finding {
  category: Category;
  status: Status;
  title: string;
  detail: string;
  steps?: string;
  evidenceId?: string;
}
export interface Evidence {
  id: string;
  label: string;
  width: number;
  height: number;
  image: string;
}
export interface CheckReport {
  id: string;
  filename: string;
  title: string;
  status: Status;
  startedAt: string;
  durationMs: number;
  findings: Finding[];
  evidence: Evidence[];
  actions: string[];
  uncovered: string[];
  engine: string;
}
export interface CheckInput { filename: string; html: string; instructions?: string }
