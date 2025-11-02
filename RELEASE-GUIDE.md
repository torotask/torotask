# Release Guide

This project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and publishing.

## The Release Process

The release process is automated through GitHub Actions. Here's how it works:

1.  **Development**: When you make a change to a package that should be included in the next release, you need to add a "changeset".
2.  **Pull Request**: Your pull request should include the code changes and the changeset file.
3.  **Merge to `main`**: Once the PR is merged, the Changesets GitHub Action will detect the new changeset file.
4.  **"Version Packages" PR**: The action will automatically create a new pull request titled "Version Packages". This PR will contain all the version bumps and changelog updates.
5.  **Publish**: When the "Version Packages" PR is merged, the Changesets action will publish the new package versions to npm.

## Adding a Changeset

To add a changeset, run the following command at the root of the project:

```bash
pnpm changeset
```

This will launch an interactive CLI that will ask you:

1.  **Which packages to version**: Select the packages that you have changed.
2.  **The type of change**: Choose between `major`, `minor`, and `patch` according to [SemVer](https://semver.org/).
3.  **A description of the change**: This will be added to the changelog.

A new markdown file will be created in the `.changeset` directory. You should commit this file with your changes.

## Pre-releases

If you want to release a pre-release version of a package (e.g., for testing a new feature), you can use "pre-release mode".

### Entering Pre-release Mode

To enter pre-release mode, run the following command:

```bash
pnpm changeset pre enter <tag>
```

Replace `<tag>` with a label for your pre-release, for example `alpha`, `beta`, or `next`.

Now, when you run `pnpm changeset`, the versions will be bumped with the pre-release tag (e.g., `1.0.1-alpha.0`).

### Exiting Pre-release Mode

To exit pre-release mode and return to normal versioning, run:

```bash
pnpm changeset pre exit
```

This will remove the pre-release tag from the versions.
