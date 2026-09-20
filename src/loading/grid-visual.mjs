// 启动页网格画布：2D 点阵在指针附近被推开后回弹，形成轻微的涟漪背景。
import { gridParams } from './visual-params.mjs'

export function startGrid(canvas) {
  if (!canvas || globalThis.matchMedia('(hover: none), (pointer: coarse)').matches) return
  const context = canvas.getContext('2d', { alpha: true, desynchronized: true })
  if (!context) return
  const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 1)
  const pointer = { x: Number.NaN, y: Number.NaN }
  const points = []
  let width = canvas.clientWidth
  let height = canvas.clientHeight
  let columns = 0
  let rows = 0
  let resizeTimer = 0
  let lastFrame = 0
  const {
    spacing,
    linkMinDistance,
    linkInset,
    influenceRadius,
    influenceForce,
    influenceScale,
    springStrength,
    damping,
    frameInterval,
    resizeDelay,
    strokeStyle,
    lineWidth,
    fillStyle,
    dotRadius,
    dotOpacity,
    proximityRadius,
    proximityOpacity,
  } = gridParams

  function rebuild() {
    columns = Math.ceil(width / spacing) + 1
    rows = Math.ceil(height / spacing) + 1
    const startX = (width - (columns - 1) * spacing) / 2
    const startY = (height - (rows - 1) * spacing) / 2
    points.length = 0
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = startX + spacing * column
        const y = startY + spacing * row
        points.push({ restX: x, restY: y, x, y, velocityX: 0, velocityY: 0 })
      }
    }
  }

  function resize() {
    width = canvas.clientWidth
    height = canvas.clientHeight
    canvas.width = width * pixelRatio
    canvas.height = height * pixelRatio
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    rebuild()
  }

  function updatePointer(event) {
    const bounds = canvas.getBoundingClientRect()
    pointer.x = event.clientX - bounds.left
    pointer.y = event.clientY - bounds.top
  }
  globalThis.addEventListener('mousemove', updatePointer)

  function connect(first, second) {
    const deltaX = second.x - first.x
    const deltaY = second.y - first.y
    const distance = Math.hypot(deltaX, deltaY)
    if (distance < linkMinDistance) return
    const directionX = deltaX / distance
    const directionY = deltaY / distance
    context.beginPath()
    context.moveTo(first.x + linkInset * directionX, first.y + linkInset * directionY)
    context.lineTo(second.x - linkInset * directionX, second.y - linkInset * directionY)
    context.stroke()
  }

  function updatePoints() {
    points.forEach((point) => {
      const deltaX = point.x - pointer.x
      const deltaY = point.y - pointer.y
      const distance = Math.hypot(deltaX, deltaY)
      if (distance < influenceRadius && distance > 0.1) {
        const force = (1 - distance / influenceRadius) * influenceForce
        point.velocityX += (deltaX / distance) * force * influenceScale
        point.velocityY += (deltaY / distance) * force * influenceScale
      }
      point.velocityX += springStrength * (point.restX - point.x)
      point.velocityY += springStrength * (point.restY - point.y)
      point.velocityX *= damping
      point.velocityY *= damping
      point.x += point.velocityX
      point.y += point.velocityY
    })
  }

  function drawLinks() {
    context.strokeStyle = strokeStyle
    context.lineWidth = lineWidth
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns - 1; column += 1) {
        connect(points[row * columns + column], points[row * columns + column + 1])
      }
    }
    for (let column = 0; column < columns; column += 1) {
      for (let row = 0; row < rows - 1; row += 1) {
        connect(points[row * columns + column], points[(row + 1) * columns + column])
      }
    }
  }

  function drawPoints() {
    context.fillStyle = fillStyle
    points.forEach((point) => {
      let radius = dotRadius
      let opacity = dotOpacity
      if (!Number.isNaN(pointer.x) && !Number.isNaN(pointer.y)) {
        const distance = Math.hypot(point.x - pointer.x, point.y - pointer.y)
        const proximity = Math.max(0, 1 - distance / influenceRadius)
        radius += proximityRadius * proximity
        opacity += proximityOpacity * proximity
      }
      context.globalAlpha = opacity
      context.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2)
    })
    context.globalAlpha = 1
  }

  function syncCanvasSize() {
    const nextWidth = canvas.clientWidth
    const nextHeight = canvas.clientHeight
    if (nextWidth === width && nextHeight === height) return
    width = nextWidth
    height = nextHeight
    canvas.width = width * pixelRatio
    canvas.height = height * pixelRatio
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    globalThis.clearTimeout(resizeTimer)
    resizeTimer = globalThis.setTimeout(rebuild, resizeDelay)
  }

  function render(timestamp) {
    globalThis.requestAnimationFrame(render)
    if (document.hidden || timestamp - lastFrame < frameInterval) return
    lastFrame = timestamp - ((timestamp - lastFrame) % frameInterval)
    syncCanvasSize()

    context.clearRect(0, 0, width, height)
    updatePoints()
    drawLinks()
    drawPoints()
  }

  resize()
  globalThis.requestAnimationFrame(render)
}
