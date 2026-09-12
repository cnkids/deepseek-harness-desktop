// 启动页鲸鱼粒子的像素采样工具。这些函数刻意放在独立模块：如果嵌在
// hero-whale.js 的 initializeHeroWhale 内，认知复杂度会层层累加。

// 判断 (x, y) 沿 offset 方向的邻居是否为空位（越界或亮度不足）。
export function isEmptyNeighbour(luminance, size, x, y, offsetX, offsetY) {
  const neighbourX = x + offsetX
  const neighbourY = y + offsetY
  if (neighbourX < 0 || neighbourY < 0 || neighbourX >= size || neighbourY >= size) return true
  return luminance[neighbourY * size + neighbourX] <= 0.2
}

// 半径 radius 内（不含中心）是否存在空位；用于挑出轮廓像素。
export function hasEmptyNeighbour(luminance, size, x, y, radius) {
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue
      if (isEmptyNeighbour(luminance, size, x, y, offsetX, offsetY)) return true
    }
  }
  return false
}

// 8 邻域空位占比，作为该像素的边缘权重（0 表示实心内部，1 表示孤立边缘）。
export function countEmptyNeighbours(luminance, size, x, y) {
  let emptyNeighbours = 0
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue
      if (isEmptyNeighbour(luminance, size, x, y, offsetX, offsetY)) emptyNeighbours += 1
    }
  }
  return emptyNeighbours / 8
}

// 粒子散布与缩放抖动只需要均匀随机扰动，不依赖伪随机序列的可复现性，
// 因此使用批量取样的 crypto.getRandomValues：既避免 SonarQube 把
// Math.random 记为安全热点（S2245），也比逐像素调用更快。
export function createRandomSource(poolSize = 1024) {
  const pool = new Uint32Array(poolSize)
  let cursor = poolSize

  return () => {
    if (cursor >= pool.length) {
      crypto.getRandomValues(pool)
      cursor = 0
    }
    const value = pool[cursor]
    cursor += 1
    return value / 4294967296
  }
}

// 把鲸鱼图像降采样成 size×size 的亮度网格，并据此生成粒子的位置、
// 透明度、边缘权重与散开位置。
export function createPixelData(image, size = 60) {
  const source = document.createElement('canvas')
  source.width = size
  source.height = size
  const context = source.getContext('2d')
  context.fillStyle = '#000'
  context.fillRect(0, 0, size, size)

  const scale = Math.min(size / image.width, size / image.height)
  const width = image.width * scale
  const height = image.height * scale
  context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height)

  const pixels = context.getImageData(0, 0, size, size)
  const luminance = new Float32Array(size * size)
  const positions = []
  const scatteredPositions = []
  const opacities = []
  const edges = []
  const center = size / 2
  const nextRandom = createRandomSource()

  for (let index = 0; index < size * size; index += 1) {
    const pixel = index * 4
    luminance[index] =
      (0.299 * pixels.data[pixel] +
        0.587 * pixels.data[pixel + 1] +
        0.114 * pixels.data[pixel + 2]) /
      255
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const opacity = luminance[y * size + x]
      if (opacity <= 0.2 || !hasEmptyNeighbour(luminance, size, x, y, 2)) continue

      positions.push((x - center) * 0.18, (center - y) * 0.18, 0)
      opacities.push(opacity)
      edges.push(countEmptyNeighbours(luminance, size, x, y))

      const azimuth = nextRandom() * Math.PI * 2
      const polar = Math.acos(2 * nextRandom() - 1)
      const radius = 3 * (0.4 + 0.6 * nextRandom())
      scatteredPositions.push(
        Math.sin(polar) * Math.cos(azimuth) * radius,
        Math.sin(polar) * Math.sin(azimuth) * radius,
        Math.cos(polar) * radius * 0.5,
      )
    }
  }

  return {
    positions: new Float32Array(positions),
    scatteredPositions: new Float32Array(scatteredPositions),
    opacities: new Float32Array(opacities),
    edges: new Float32Array(edges),
    count: positions.length / 3,
  }
}
