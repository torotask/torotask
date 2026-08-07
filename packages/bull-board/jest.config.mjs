import { createJsWithTsEsmPreset } from 'ts-jest';

export default {
  displayName: 'bull-board',
  ...createJsWithTsEsmPreset({
    tsconfig: 'tsconfig.jest.json',
  }),
  testMatch: ['**/__tests__/**/*.unit.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^torotask$': '<rootDir>/../torotask/src/index.ts',
  },
  transformIgnorePatterns: ['!node_modules/(?!lodash-es)'],
};
