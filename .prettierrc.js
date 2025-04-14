module.exports = {
  htmlWhitespaceSensitivity: 'ignore',
  semi: true,
  endOfLine: 'auto',
  useTabs: false,
  tabWidth: 2,
  printWidth: 120,
  singleQuote: true,
  proseWrap: 'always',
  trailingComma: 'es5',
  bracketSpacing: true,
  arrowParens: 'always',
  overrides: [
    {
      files: ['package.json', '*.yml', '*.yaml'],
      options: {
        useTabs: false,
        tabWidth: 2,
      },
    },
  ],
};
