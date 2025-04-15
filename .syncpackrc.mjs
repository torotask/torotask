// @ts-check

/** @type {import("syncpack").RcFile} */
const config = {
  dependencyTypes: ['**'],

  sortAz: [
    'bin',
    'contributors',
    'dependencies',
    'devDependencies',
    'keywords',
    'peerDependencies',
    'resolutions',
    'scripts',
  ],
  sortExports: ['types', 'node-addons', 'node', 'browser', 'import', 'require', 'development', 'production', 'default'],
  sortFirst: [
    'name',
    'version',
    'publishConfig',
    'private',
    'keywords',
    'description',
    'author',
    'license',
    'repository',
    'homepage',
    'bugs',
    'scripts',
    'type',
    'main',
    'dependencies',
    'devDependencies',
    'peerDependencies',
  ],
  versionGroups: [
    {
      label: 'Use workspace protocol when developing local packages',
      dependencies: ['@torotask/*'],
      dependencyTypes: ['dev', 'prod'],
      pinVersion: 'workspace:*',
    },
  ],
};

export default config;
