import antfu from '@antfu/eslint-config';

export default antfu(
  {
    stylistic: {
      semi: true,

    },
    typescript: {
      overrides: {
        'node/prefer-global/process': 'off',
        'no-console': 'off',
      },
    },
  },
  {
    files: ['**/__tests__/**'],
    rules: {
      'no-var': 'off',
      'vars-on-top': 'off',
    },
  },
);
