/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  maxWorkers: '25%',
  workerIdleMemoryLimit: '512MB',
  // Disables HTTP keep-alive so supertest never reuses a pooled socket across
  // its per-request listen/close port churn — see jest.setup.cjs for the full
  // root cause. Runs once per test file, before the framework loads.
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: './tsconfig.test.json',
        diagnostics: { ignoreCodes: ['TS2307', 'TS2304', 'TS2345'] },
      },
    ],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  // Map .js imports (NodeNext style) to .ts sources so ts-jest can resolve them.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
