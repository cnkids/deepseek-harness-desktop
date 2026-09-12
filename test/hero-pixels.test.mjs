import assert from 'node:assert/strict'
import test from 'node:test'
import {
  countEmptyNeighbours,
  createPixelData,
  hasEmptyNeighbour,
  isEmptyNeighbour,
} from '../src/hero-pixels.mjs'

// 3x3 网格，行主序；只有中心像素是亮的。
function createCentreLitData(size = 3) {
  const data = new Uint8ClampedArray(size * size * 4)
  const centre = (size + 1) * 4
  data[centre] = 255
  data[centre + 1] = 255
  data[centre + 2] = 255
  data[centre + 3] = 255
  return data
}

function installCanvasStub(data) {
  const original = globalThis.document
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          fillStyle: '',
          fillRect() {},
          drawImage() {},
          getImageData: () => ({ data }),
        }),
      }
    },
  }
  return () => {
    globalThis.document = original
  }
}

test('treats out-of-bounds and dark pixels as empty neighbours', () => {
  const size = 3
  const luminance = new Float32Array(size * size)
  luminance[size + 1] = 1

  assert.equal(isEmptyNeighbour(luminance, size, 1, 1, 1, 0), true)
  assert.equal(isEmptyNeighbour(luminance, size, 1, 1, -1, 0), true)
  assert.equal(isEmptyNeighbour(luminance, size, 1, 1, 2, 0), true)
  assert.equal(isEmptyNeighbour(luminance, size, 0, 0, -1, 0), true)
  assert.equal(isEmptyNeighbour(luminance, size, 0, 0, 0, -1), true)

  const solid = new Float32Array(size * size).fill(1)
  assert.equal(isEmptyNeighbour(solid, size, 1, 1, 1, 0), false)
})

test('detects a lit pixel inside an empty radius', () => {
  const size = 3
  const luminance = new Float32Array(size * size)
  luminance[size + 1] = 1

  assert.equal(hasEmptyNeighbour(luminance, size, 1, 1, 2), true)

  const solid = new Float32Array(size * size).fill(1)
  assert.equal(hasEmptyNeighbour(solid, size, 1, 1, 1), false)
})

test('counts empty neighbours as an edge ratio', () => {
  const size = 3

  // 亮中心、8 邻域全暗 → 空位占比 1。
  const centreLit = new Float32Array(size * size)
  centreLit[size + 1] = 1
  assert.equal(countEmptyNeighbours(centreLit, size, 1, 1), 1)

  // 全亮时中心没有空位邻居；角像素只有 5 个越界邻居。
  const solid = new Float32Array(size * size).fill(1)
  assert.equal(countEmptyNeighbours(solid, size, 1, 1), 0)
  assert.equal(countEmptyNeighbours(solid, size, 0, 0), 5 / 8)
})

test('samples a lit image into particle data', () => {
  const size = 3
  const restore = installCanvasStub(createCentreLitData(size))

  try {
    const result = createPixelData({ width: size, height: size }, size)
    assert.equal(result.count, 1)
    assert.equal(result.positions.length, 3)
    assert.equal(result.scatteredPositions.length, 3)
    assert.ok(Math.abs(result.positions[0] - -0.09) < 1e-6)
    assert.ok(Math.abs(result.positions[1] - 0.09) < 1e-6)
    assert.equal(result.positions[2], 0)
    assert.ok(Math.abs(result.opacities[0] - 1) < 1e-6)
    assert.equal(result.edges[0], 1)
  } finally {
    restore()
  }
})

test('returns empty particle data for a fully dark image', () => {
  const size = 3
  const restore = installCanvasStub(new Uint8ClampedArray(size * size * 4))

  try {
    const result = createPixelData({ width: size, height: size }, size)
    assert.equal(result.count, 0)
    assert.equal(result.positions.length, 0)
    assert.equal(result.scatteredPositions.length, 0)
  } finally {
    restore()
  }
})
