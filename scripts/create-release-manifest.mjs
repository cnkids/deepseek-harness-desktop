#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import semver from 'semver'

const supportedExtensions = ['.dmg', '.zip', '.exe', '.AppImage', '.deb']

export async function createReleaseManifest({ input, output, version, baseUrl, repository }) {
  if (!semver.valid(version)) throw new Error(`Invalid release version: ${version}`)
  if (!/^https:\/\//.test(baseUrl)) throw new Error('baseUrl must be an HTTPS URL')

  const names = (await readdir(input))
    .filter((name) => supportedExtensions.some((extension) => name.endsWith(extension)))
    .sort()
  if (names.length === 0) throw new Error(`No release assets found in ${input}`)

  const releasePrefix = `${baseUrl.replace(/\/$/, '')}/deepseek-harness-desktop/releases/v${version}`
  const assets = []
  for (const name of names) {
    const file = path.join(input, name)
    const [contents, metadata] = await Promise.all([readFile(file), stat(file)])
    assets.push({
      name,
      size: metadata.size,
      sha256: createHash('sha256').update(contents).digest('hex'),
      url: `${releasePrefix}/${encodeURIComponent(name)}`,
    })
  }

  const manifest = {
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    githubRelease: `https://github.com/${repository}/releases/tag/v${version}`,
    assets,
  }
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

// Compare the resolved entry path instead of string-concatenating a file://
// URL: the old form silently skipped the CLI on Windows drive letters and on
// paths needing percent-encoding. import.meta.filename is already fully
// resolved (macOS reveals /var -> /private/var), so resolve argv[1] too.
function isCliEntryPath(value) {
  if (!value) return false
  try {
    return import.meta.filename === realpathSync(value)
  } catch {
    return false
  }
}

const isCliEntry = isCliEntryPath(process.argv[1])
if (isCliEntry) {
  const args = {
    input: option('--input'),
    output: option('--output'),
    version: option('--version'),
    baseUrl: option('--base-url'),
    repository: option('--repository') ?? 'cnkids/deepseek-harness-desktop',
  }
  if (!args.input || !args.output || !args.version || !args.baseUrl) {
    console.error('Usage: create-release-manifest.mjs --input DIR --output FILE --version X.Y.Z --base-url URL [--repository OWNER/REPO]')
    process.exit(2)
  }
  await createReleaseManifest(args)
}
