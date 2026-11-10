// Types for node-free-graph.mjs (the portal's tsc checks the tests that import it).
export declare const NODE_ONLY_PACKAGES: string[];
export declare const GRAPH_REPORT: string;
export declare function nodeOnlyReason(id: string): string | null;
export declare function nodeOnlyModules(ids: Iterable<string>): Array<{ id: string; reason: string }>;
export declare function nodeFreeGraph(opts?: { root?: string; report?: string }): {
  name: string;
  apply: 'build';
  generateBundle(this: { getModuleIds(): IterableIterator<string>; error(message: string): never }): void;
};
