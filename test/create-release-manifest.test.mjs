import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createReleaseManifest } from '../scripts/create-release-manifest.mjs'

const scriptPath = fileURLToPath(
  new URL('../scripts/create-release-manifest.mjs', import.meta.url),
)

test('creates a stable manifest for supported release assets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-release-'))
  await writeFile(path.join(directory, 'app.dmg'), 'dmg')
  await writeFile(path.join(directory, 'app.exe'), 'exe')
  await writeFile(path.join(directory, 'builder-debug.yml'), 'ignored')
  const output = path.join(directory, 'latest.json')

  const manifest = await createReleaseManifest({
    input: directory,
    output,
    version: '1.2.3',
    repository: 'owner/repo',
  })

  assert.equal(manifest.version, '1.2.3')
  assert.deepEqual(manifest.assets.map((asset) => asset.name), ['app.dmg', 'app.exe'])
  assert.equal(
    manifest.assets[0].url,
    'https://github.com/owner/repo/releases/download/v1.2.3/app.dmg',
  )
  assert.equal(manifest.githubRelease, 'https://github.com/owner/repo/releases/tag/v1.2.3')
  assert.equal(manifest.assets[0].sha256.length, 64)
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), manifest)
})

test('rejects a repository that is not owner/name', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-release-repo-'))
  await assert.rejects(
    createReleaseManifest({
      input: directory,
      output: path.join(directory, 'latest.json'),
      version: '1.2.3',
      repository: 'not-a-repository',
    }),
    /Invalid repository/,
  )
})

test('rejects releases without installable assets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-release-empty-'))
  await assert.rejects(
    createReleaseManifest({
      input: directory,
      output: path.join(directory, 'latest.json'),
      version: '1.2.3',
      repository: 'owner/repo',
    }),
    /No release assets/,
  )
})

test('CLI entry detection works from a path containing spaces', async (t) => {
  if (process.platform === 'win32') {
    t.skip('creating symlinks needs elevated rights on Windows')
    return
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-release-cli-'))
  const spaceDir = path.join(root, 'space dir')
  const binDir = path.join(spaceDir, 'scripts')
  const inputDir = path.join(spaceDir, 'input')
  const outputFile = path.join(spaceDir, 'latest.json')
  try {
    await mkdir(binDir, { recursive: true })
    await mkdir(inputDir, { recursive: true })
    await writeFile(path.join(inputDir, 'app.dmg'), 'dmg')
    await copyFile(scriptPath, path.join(binDir, 'create-release-manifest.mjs'))
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(spaceDir, 'node_modules'),
      'dir',
    )

    const result = spawnSync(
      process.execPath,
      [
        path.join(binDir, 'create-release-manifest.mjs'),
        '--input',
        inputDir,
        '--output',
        outputFile,
        '--version',
        '9.9.9',
        '--repository',
        'owner/repo',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(await readFile(outputFile, 'utf8'))
    assert.equal(manifest.version, '9.9.9')
    assert.equal(manifest.assets.length, 1)
    assert.equal(
      manifest.assets[0].url,
      'https://github.com/owner/repo/releases/download/v9.9.9/app.dmg',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
