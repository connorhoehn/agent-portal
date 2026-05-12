declare module 'node-cron' {
  namespace cron {
    interface ScheduledTask {
      start(): void;
      stop(): void;
      destroy(): void;
      getStatus(): string;
    }

    interface ScheduleOptions {
      scheduled?: boolean;
      timezone?: string;
      recoverMissedExecutions?: boolean;
      name?: string;
      runOnInit?: boolean;
    }

    function schedule(
      cronExpression: string,
      func: () => void | Promise<void>,
      options?: ScheduleOptions,
    ): ScheduledTask;

    function validate(cronExpression: string): boolean;

    function getTasks(): Map<string, ScheduledTask>;
  }

  export = cron;
}
