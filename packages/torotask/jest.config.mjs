import { createJsWithTsEsmPreset } from 'ts-jest';

export default {
  displayName: 'js-with-ts',
  ...createJsWithTsEsmPreset({
    tsconfig: 'tsconfig.jest.json',
  }),

  // Only run actual test files
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],

  // Don't treat helper files as tests
  testPathIgnorePatterns: ['node_modules', 'dist', '__tests__/helpers/', '__tests__/setup.ts', '__tests__/jest.d.ts'],

  // Module name mapping for .js extensions
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },

  transformIgnorePatterns: ['!node_modules/(?!lodash-es)'],

  // Suppress console output during tests for cleaner output
  silent: false, // Keep this false so we can see test results
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
};
