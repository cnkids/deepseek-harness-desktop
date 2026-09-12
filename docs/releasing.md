# Release guide

## GitHub release

Run the release command from a clean, up-to-date `main` branch:

```sh
npm run release -- 0.3.0
```

Pushing the generated `v0.3.0` tag starts `.github/workflows/release.yml`. The workflow builds on native GitHub-hosted runners and publishes DMG/ZIP, EXE, AppImage, and DEB assets to the matching GitHub Release.

The workflow can also be re-run manually. Choose **Actions → Package and publish release → Run workflow** and enter a version that exactly matches `package.json`.

## Update source

The same workflow publishes `latest.json` with every release, next to the installers. Clients read it from a stable URL:

```text
https://github.com/cnkids/deepseek-harness-desktop/releases/latest/download/latest.json
```

`scripts/create-release-manifest.mjs` builds the manifest from the packaged assets and pins every download URL to `https://github.com/<owner>/<repo>/releases/download/vX.Y.Z/<asset>`, so a published manifest never changes. No repository secrets or bucket configuration are required.

Packaged desktop clients consume this manifest for automatic updates. They compare its SemVer with the running app, select the native asset, download it in the background, and require both the declared byte size and SHA-256 to match before offering installation. Keep `schemaVersion: 1`, version-pinned download URLs, and the `electron-builder` artifact names stable unless the client-side update parser is changed in the same release.

`DESKTOP_UPDATE_MANIFEST_URL` in `src/app-update.mjs` must keep pointing at the `releases/latest/download/` shortcut. Changing it only affects builds produced after the edit: an installed client keeps the URL baked into its own build, so a client that predates the change never learns about the new source and has to be upgraded manually once.

Update installation is platform-aware: Windows launches the verified NSIS installer after quitting; a running Linux AppImage is replaced atomically and restarted; DEB and macOS DMG packages are opened with the system installer. A failed check, download, or installation leaves the currently installed app usable.
