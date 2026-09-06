import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {
  isAllowedNavigationUrl,
  isAllowedRendererPermission,
  isStartupPageUrl,
  isTrustedIpcSender,
} from '../src/security-policy.mjs'

const loadingHtmlPath = path.join(path.sep, 'app', 'resources', 'src', 'loading.html')
const loadingFileUrl = pathToFileURL(loadingHtmlPath).href
const harnessOrigin = 'http://127.0.0.1:5678'

test('accepts only the exact local loading page as a file: navigation target', () => {
  assert.equal(isStartupPageUrl(loadingFileUrl, loadingHtmlPath), true)
  assert.equal(
    isStartupPageUrl(`${loadingFileUrl}?retry=1`, loadingHtmlPath),
    true,
  )
  assert.equal(isStartupPageUrl(`${loadingFileUrl}#state`, loadingHtmlPath), true)
  assert.equal(
    isStartupPageUrl(pathToFileURL(path.join(path.sep, 'etc', 'passwd')).href, loadingHtmlPath),
    false,
  )
  assert.equal(isStartupPageUrl('file:///Users/me/secret.html', loadingHtmlPath), false)
  assert.equal(isStartupPageUrl('https://example.com/', loadingHtmlPath), false)
  assert.equal(isStartupPageUrl('not a url', loadingHtmlPath), false)
})

test('limits navigation to the loading page and the current harness origin', () => {
  const options = { loadingHtmlPath, harnessOrigin }
  assert.equal(isAllowedNavigationUrl(loadingFileUrl, options), true)
  assert.equal(isAllowedNavigationUrl(`${harnessOrigin}/chat`, options), true)
  assert.equal(isAllowedNavigationUrl('http://localhost:9999/', options), false)
  assert.equal(isAllowedNavigationUrl('http://127.0.0.1:1/', options), false)
  assert.equal(isAllowedNavigationUrl('https://example.com/', options), false)
  assert.equal(isAllowedNavigationUrl('file:///etc/hosts', options), false)
  assert.equal(isAllowedNavigationUrl('javascript:alert(1)', options), false)
  assert.equal(isAllowedNavigationUrl('', { loadingHtmlPath, harnessOrigin: null }), false)
  assert.equal(isAllowedNavigationUrl(`${harnessOrigin}/`, { loadingHtmlPath, harnessOrigin: null }), false)
})

test('trusts restart IPC only from the loading page frame', () => {
  const frame = (url) => ({ url })
  assert.equal(isTrustedIpcSender(frame(loadingFileUrl), loadingHtmlPath), true)
  assert.equal(isTrustedIpcSender(frame(`${harnessOrigin}/`), loadingHtmlPath), false)
  assert.equal(isTrustedIpcSender(frame('file:///tmp/other.html'), loadingHtmlPath), false)
  assert.equal(isTrustedIpcSender(null, loadingHtmlPath), false)
})

test('denies system permissions except clipboard writes', () => {
  assert.equal(isAllowedRendererPermission('clipboard-sanitized-write'), true)
  assert.equal(isAllowedRendererPermission('clipboard-write'), true)
  for (const permission of [
    'media',
    'notifications',
    'geolocation',
    'fullscreen',
    'clipboard-read',
    'openExternal',
    'hid',
    'serial',
    'unknown-permission',
  ]) {
    assert.equal(isAllowedRendererPermission(permission), false, permission)
  }
})
