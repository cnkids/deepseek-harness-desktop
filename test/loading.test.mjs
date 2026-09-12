import assert from 'node:assert/strict'
import test from 'node:test'

// loading.js 直接操作 DOM，这里用最小桩模拟 #message、进度条与四个阶段节点，
// 以便在 Node 中驱动真实的 renderStatus 状态机。
function createElement(id) {
  return {
    id,
    value: null,
    hidden: false,
    disabled: false,
    textContent: '',
    dataset: {},
    style: {},
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
    getAttribute(name) {
      return this.attributes.get(name) ?? null
    },
    addEventListener() {},
    querySelector() {
      return null
    },
  }
}

function installDom() {
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

  const body = createElement('body')
  globalThis.document = {
    body,
    querySelector: (selector) =>
      selector.startsWith('#') ? element(selector.slice(1)) : null,
    querySelectorAll: (selector) => (selector === '.stage' ? stages : []),
    addEventListener() {},
  }
  globalThis.dispatchEvent = () => true
  globalThis.requestAnimationFrame = (callback) => {
    callback(0)
    return 1
  }

  return { element, stages }
}

const { element, stages } = installDom()

let renderStatus = null
globalThis.desktopRuntime = {
  onStatus(callback) {
    renderStatus = callback
    return () => {}
  },
  retry: async () => {},
}

await import('../src/loading.js')

test('exposes the status handler from the preload bridge', () => {
  assert.equal(typeof renderStatus, 'function')
})

test('renders determinate progress through the native meter', () => {
  renderStatus({ message: '正在安装 DeepSeek Harness', detail: '下载中', progress: 68 })

  assert.equal(element('message').textContent, '正在安装 DeepSeek Harness')
  assert.equal(element('detail').textContent, '下载中')
  assert.equal(element('progress-value').textContent, '68%')
  assert.equal(element('progress-label').textContent, '初始化中')
  assert.equal(element('progress-meter').value, 68)
  assert.equal(element('progress-track').classList.contains('is-determinate'), true)
  assert.equal(element('retry').hidden, true)
})

test('falls back to the indeterminate meter without progress', () => {
  renderStatus({ message: '正在检查运行环境', detail: '查找兼容的 Node.js' })

  assert.equal(element('progress-meter').value, null)
  assert.equal(element('progress-value').textContent, '···')
  assert.equal(element('progress-track').classList.contains('is-determinate'), false)
})

test('announces completion once the harness is ready', () => {
  renderStatus({ message: 'Harness 已启动', detail: '就绪', progress: 100 })

  assert.equal(element('progress-label').textContent, '即将就绪')
  assert.equal(stages[3].classList.contains('is-complete'), true)
  assert.equal(element('stage-0-state').textContent, '完成')
})

test('marks the failing stage and exposes the retry button', () => {
  renderStatus({ message: '正在安装 DeepSeek Harness', progress: 10 })
  renderStatus({ message: '启动失败', detail: '网络超时', error: true })

  assert.equal(element('retry').hidden, false)
  assert.equal(element('progress-label').textContent, '启动中断')
  assert.equal(element('stage-0-state').textContent, '异常')
  assert.equal(stages[0].classList.contains('has-stage-error'), true)
})
