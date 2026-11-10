// Types for dev-server.mjs (vite.config.ts imports it).
export declare const DEFAULT_PORT: number;
export declare const DEFAULT_HOST: string;
export declare function devServerOptions(env?: Record<string, string | undefined>): {
  port: number;
  host: string;
  strictPort?: true;
};
