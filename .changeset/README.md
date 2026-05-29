# Changesets

Rune uses [Changesets](https://github.com/changesets/changesets) to record user-facing package changes, update versions, and publish releases.

For changes after the initial unpublished `0.1.0` release:

1. Run `bun run changeset` and describe the user-visible change.
2. Commit the generated `.changeset/*.md` file with the implementation.
3. Run `bun run version-packages` when preparing a release commit.
4. Run `bun run release` to validate and publish the versioned package.

The initial `0.1.0` package version is already defined in `package.json`; it can be published through `bun run release` without a pending version changeset because it has not yet been published.
