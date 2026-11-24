# Contributing to ScadStudio

Thanks for your interest in ScadStudio. It is an early beta with one maintainer, so the most useful contributions right now are bug reports with a `.scad` file that shows the problem, and small, focused pull requests.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and asking for features

- Search [existing issues](https://github.com/TheSingularis/scadstudio/issues) first.
- Use the **Bug report** template. Include the ScadStudio version (the release tag, for example `beta-v0.1.1`), your OS, and the smallest `.scad` source that reproduces the problem. Paste it into the issue; most bugs in a source-preserving editor depend on the exact text.
- If the file renders differently in desktop OpenSCAD, say which OpenSCAD version you compared with.
- Security problems: see [SECURITY.md](SECURITY.md) instead of opening a public issue.
- For a feature, check the roadmap in [PLAN.md](PLAN.md) first. Many ideas are already planned for a specific milestone.

## Before you start on a pull request

Open an issue (or comment on one) before starting anything bigger than a small fix, so the approach can be agreed first. The milestone plan in [PLAN.md](PLAN.md) decides what gets built when, and a PR that cuts across an in-progress milestone may need to wait.

## Development setup

You need Node.js 22 (what CI uses) and npm. Git is needed for the real-world test corpus.

```sh
git clone https://github.com/TheSingularis/scadstudio.git
cd scadstudio
npm ci
cd apps/desktop
npm run dev        # launches the app with hot reload
```

Other scripts in `apps/desktop`:

| Command | What it does |
| --- | --- |
| `npm run build` | Production bundle into `apps/desktop/out/` |
| `npm run start` | Runs the production bundle |
| `npm run typecheck` | TypeScript check of the app |
| `npm run package:linux` | Builds a Linux AppImage into `apps/desktop/dist/` |
| `npm run package:win` | Builds a Windows portable `.exe` (run on Windows) |

On Linux without a display (a container, SSH, CI), Electron needs a virtual display: see the "Running headless" notes in [TESTING.md](TESTING.md).

## How the code is laid out

- `apps/desktop/src/main/` is the Electron main process: file dialogs, saving, and rendering through `openscad-wasm`.
- `apps/desktop/src/preload/` is the bridge the renderer uses to call the main process.
- `apps/desktop/src/renderer/` is the React UI: the Monaco editor, the three.js viewport, the toolbar, sketch mode, and the code that patches `.scad` source (`targetedPatch.ts`).
- `apps/desktop/test/` holds the unit, integration, corpus and end-to-end tests.
- `spikes/` holds early de-risking scripts. They are not part of the app.

[PLAN.md](PLAN.md) explains the architecture and why it is built this way. Its section "Where the build diverges from this plan" lists where the code differs from the original design.

## Ground rules for changes

- **The file is the source of truth.** Every visual edit must produce valid OpenSCAD and must change only the part of the file it is about. Comments, formatting and unrelated code must survive untouched. There is no separate save format.
- **Add or update tests.** Name tests after the milestone they guard. See [TESTING.md](TESTING.md) for the helpers and for how known bugs are kept as expected failures.
- Keep pull requests focused on one change, and describe what a user will see differently.

## Tests and checks

```sh
npm test                                     # unit + integration, from the repo root
npm run test:e2e -w @scadstudio/desktop      # builds the app and runs the Electron tests
```

Every pull request runs these checks, and `main` requires them to pass before merging:

- **Unit + integration**: typecheck, unit, integration and real-world corpus tests.
- **End-to-end (Electron under Xvfb)**: the built app, driven with real mouse and keyboard input.

A third check, **No AI attribution**, fails if commits or files carry AI tool attribution trailers or footers. Please leave those out of commit messages and PR descriptions.

## License

ScadStudio is licensed under the GNU General Public License, version 3 or later. By contributing, you agree that your contributions are licensed under the same terms (see [LICENSE](LICENSE)).
