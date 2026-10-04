export type ServiceStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export interface ServiceHealth {
  status: ServiceStatus;
  /** A safe user-facing description, never raw integration errors or paths. */
  message?: string;
}
