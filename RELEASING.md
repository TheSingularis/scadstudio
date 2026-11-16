# Releasing

Each completed milestone gets its own GitHub pre-release.

## Tag convention

- Tags are `beta-v<major>.<minor>.<patch>`. The first is `beta-v0.1.0`.
- Every completed milestone bumps the **patch** number: `beta-v0.1.1`, `beta-v0.1.2`, and so on. The minor number changes only when Jordan says so.
- The older `v0.1.0-beta.1` to `v0.1.0-beta.7` tags predate this convention and stay as they are.
- All of these are pre-releases. There is no stable release yet.

## Steps for a milestone

1. Merge the milestone's PR(s) into `main`.
2. Set `version` in `apps/desktop/package.json` to the number in the tag, without the `beta-v` prefix (tag `beta-v0.1.1` means version `0.1.1`). electron-builder takes the artifact name from it.
3. Optional but preferred: write `release-notes/<tag>.md`, a few lines on what the milestone added. If the file is missing, GitHub's generated notes are used.
4. Tag the merge commit on `main` and push the tag: `git tag beta-v0.1.1 && git push origin beta-v0.1.1`.

Pushing the tag runs `.github/workflows/build-desktop.yml`. It builds the Linux AppImage and the Windows portable exe, smoke-tests them, and creates the pre-release with both attached. Don't create the release by hand, or the workflow's `gh release create` step fails because the release already exists.

## No AI attribution

Release notes, commits and PR bodies must not carry AI tool attribution (the `no-ai-attribution` workflow checks this). The project-required "requested by" block on PRs is the one exception.
