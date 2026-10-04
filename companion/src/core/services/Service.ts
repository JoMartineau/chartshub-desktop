export interface Service {
  start(): Promise<void>;
  stop(): void;
}
