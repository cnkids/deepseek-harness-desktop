import assert from 'node:assert/strict'
import test from 'node:test'

// loading.js 在没有 preload 桥时会进入 demo 分支（?demo=xxx 预览）。
// 该分支只在模块首次求值时决定，因此单独用一个测试文件装载它。

function createElement(id) {
  return {
    id,
    value: null,
    hidden: false,
    disabled: false,
    textContent: '',
    dataset: {},
    style: {},
    listeners: {},
    attributes: new Map(),
    classList: {
      values: new Set(),
      add(name) {
        this.values.add(name)
      },
      remove(name) {
        this.values.delete(name)
      },
      toggle(name, force) {
        if (force) this.values.add(name)
        else this.values.delete(name)
      },
      contains(name) {
        return this.values.has(name)
      },
    },
    setAttribute(name, value) {
      this.attributes.set(name, value)
      if (name === 'value') this.value = value
    },
    removeAttribute(name) {
      this.attributes.delete(name)
      if (name === 'value') this.value = null
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler
    },
    querySelector() {
      return null
    },
  }
}

const elements = new Map()
const element = (id) => {
  if (!elements.has(id)) elements.set(id, createElement(id))
  return elements.get(id)
}
const stages = Array.from({ length: 4 }, (_, index) => {
  const stage = createElement(`stage-${index}`)
  stage.querySelector = () => element(`stage-${index}-state`)
  return stage
})

globalThis.document = {
  body: createElement('body'),
  querySelector: (selector) => (selector.startsWith('#') ? element(selector.slice(1)) : null),
  querySelectorAll: (selector) => (selector === '.stage' ? stages : []),
  addEventListener() {},
}
globalThis.dispatchEvent = () => true
globalThis.requestAnimationFrame = (callback) => {
  callback(0)
  return 1
}
globalThis.location = { search: '?demo=ready' }

await import('../src/loading.js')

test('renders the demo state requested by the query string', () => {
  assert.equal(element('message').textContent, '正在等待 Harness 界面')
  assert.equal(element('detail').textContent, '本地服务已启动，正在连接 Web UI。')
  assert.equal(element('progress-value').textContent, '92%')
  assert.equal(element('progress-meter').value, 92)
  assert.equal(element('retry').hidden, true)
})

test('retry button replays the environment demo', () => {
  assert.equal(typeof element('retry').listeners.click, 'function')

  element('retry').listeners.click()

  assert.equal(element('message').textContent, '正在检查运行环境')
  assert.equal(element('progress-meter').value, null)
  assert.equal(element('progress-track').classList.contains('is-determinate'), false)
})
