/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  maxWorkers: '25%',
  workerIdleMemoryLimit: '512MB',
  // Disables HTTP keep-alive so supertest never reuses a pooled socket across
  // its per-request listen/close port churn — see jest.setup.cjs for the full
  // root cause. Runs once per test file, before the framework loads.
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  // Binds ONE http.Server per test file for supertest to reuse, instead of
  // supertest's default of one listen/close per request. Must be
  // setupFilesAfterEnv (not setupFiles) because it registers beforeAll/afterAll.
  // See src/test-support/http.ts for the full root cause.
  setupFilesAfterEnv: ['<rootDir>/src/test-support/jest-shared-server.ts'],
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: './tsconfig.test.json',
      },
    ],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  // Map .js imports (NodeNext style) to .ts sources so ts-jest can resolve them.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
