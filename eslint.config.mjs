import antfu from '@antfu/eslint-config';

export default antfu({
  stylistic: {
    semi: true,

  },
  typescript: {
    overrides: {
      'node/prefer-global/process': 'off',
      'style/comma-dangle': 'off',
      'no-console': 'off',
    },
  },
});
