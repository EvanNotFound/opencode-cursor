# Publishing `@evanovation/open-cursor`

This project is publishable as the npm package `@evanovation/open-cursor`. It ships as an OpenCode plugin package and does not include setup CLI binaries.

## Prerequisites

- npm account with publish access for `@evanovation/open-cursor`
- `NPM_TOKEN` configured in GitHub Actions repository secrets
- Clean `main` branch with passing CI

## Release Checklist

1. Decide if this is a publish-worthy change.
   - Docs-only or refactors with no user-visible behavior change: do not publish.
   - User-visible changes (plugin behavior or package setup): publish.
2. Update version in `package.json` (semver) only when publishing.
2. Build and run tests locally:
   - `bun install`
   - `bun run build`
   - `bun run test:ci:unit`
   - `bun run test:ci:integration`
3. Confirm package contents:
   - `npm pack --dry-run`
4. Confirm target version is not already published:
   - `npm view @evanovation/open-cursor version`
5. Commit and push the version bump to `main`.
6. Create and push a release tag:
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`

## GitHub Actions Publish Flow

The workflow in `.github/workflows/publish.yml` publishes automatically on:

- `push` tags matching `v*`
- Manual `workflow_dispatch`

Publish step:

- `npm publish --access public`

If you need a non-publish validation run, execute the same build/test steps locally and use `npm pack --dry-run`.

## Dist Tags (Optional)

Use dist-tags for pre-releases instead of publishing a rapid stream of patch versions:
- `latest`: stable releases
- `beta`: pre-release channel (for example `2.2.0-beta.1`)
