// 启动页流体画布：WebGL2 程序、流场纹理与渲染循环。
import { fluidParams } from './visual-params.mjs'
import { flowShader, fluidShader, vertexShader } from './shaders.mjs'

function colorToRgb(color) {
  const value = color.replace('#', '')
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ]
}

export function startFluid(canvas, { lowPowerDevice }) {
  if (!canvas) return
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: false,
    powerPreference: 'low-power',
  })
  if (!gl) return

  function createShader(type, source) {
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
    console.error('[background] shader', gl.getShaderInfoLog(shader))
    return null
  }

  function createProgram(fragmentSource) {
    const vertex = createShader(gl.VERTEX_SHADER, vertexShader)
    const fragment = createShader(gl.FRAGMENT_SHADER, fragmentSource)
    if (!vertex || !fragment) return null
    const program = gl.createProgram()
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program
    console.error('[background] link', gl.getProgramInfoLog(program))
    return null
  }

  const flowProgram = createProgram(flowShader)
  const fluidProgram = createProgram(fluidShader)
  if (!flowProgram || !fluidProgram) return

  const flowUniforms = {
    prev: gl.getUniformLocation(flowProgram, 'u_prev'),
    mouse: gl.getUniformLocation(flowProgram, 'u_mouse'),
    velocity: gl.getUniformLocation(flowProgram, 'u_velocity'),
    brushRadius: gl.getUniformLocation(flowProgram, 'u_brushRadius'),
    brushStrength: gl.getUniformLocation(flowProgram, 'u_brushStrength'),
    decay: gl.getUniformLocation(flowProgram, 'u_decay'),
  }
  const fluidUniforms = {}
  ;[
    'time',
    'resolution',
    'scale',
    'offset',
    'grain',
    'speed',
    'flowmap',
    'distortBoost',
    'swirlBoost',
    'glowIntensity',
    'glowColor1',
    'glowColor2',
    'glowColor3',
    'c1',
    'c2',
    'c3',
    'c4',
    'c5',
    'lightPos',
    'lightCore',
    'lightHalo',
    'vignette',
    'bloomThreshold',
    'bloomRange',
    'bloomStrength',
  ].forEach((name) => {
    fluidUniforms[name] = gl.getUniformLocation(fluidProgram, `u_${name}`)
  })

  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  )

  function bindPosition(program) {
    const location = gl.getAttribLocation(program, 'a_position')
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
  }

  function createTarget(width, height, data) {
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data || null,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const framebuffer = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    )
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { framebuffer, texture }
  }

  // This is a full-window procedural shader. Rendering it above CSS-pixel
  // resolution adds a lot of GPU work with almost no visible benefit behind
  // the grain and gradient layers.
  const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, lowPowerDevice ? 0.8 : 1)
  let width = Math.round(canvas.clientWidth * pixelRatio)
  let height = Math.round(canvas.clientHeight * pixelRatio)
  canvas.width = width
  canvas.height = height
  const flowWidth = Math.round(width / 4)
  const flowHeight = Math.round(height / 4)
  const initialFlow = new Uint8Array(flowWidth * flowHeight * 4)
  for (let index = 0; index < flowWidth * flowHeight; index += 1) {
    initialFlow[index * 4] = 0
    initialFlow[index * 4 + 1] = 128
    initialFlow[index * 4 + 2] = 128
    initialFlow[index * 4 + 3] = 255
  }
  const targetA = createTarget(flowWidth, flowHeight, initialFlow)
  const targetB = createTarget(flowWidth, flowHeight, initialFlow)
  let useFirst = false
  let visible = true
  let lastFrame = 0
  let revealed = false
  const startedAt = performance.now()
  const pointer = {
    x: 0.5,
    y: 0.5,
    smoothX: 0.5,
    smoothY: 0.5,
    smoothVelocityX: 0,
    smoothVelocityY: 0,
  }
  const coarsePointer = globalThis.matchMedia('(hover: none), (pointer: coarse)').matches
  const isWindows = navigator.userAgentData
    ? navigator.userAgentData.platform === 'Windows'
    : navigator.userAgent.includes('Windows')
  const interactive = !coarsePointer && !isWindows
  const frameInterval = 1000 / (lowPowerDevice ? 24 : 30)

  function updatePointer(event) {
    const bounds = canvas.getBoundingClientRect()
    pointer.x = (event.clientX - bounds.left) / bounds.width
    pointer.y = 1 - (event.clientY - bounds.top) / bounds.height
  }
  if (interactive) globalThis.addEventListener('mousemove', updatePointer)

  function render(timestamp) {
    globalThis.requestAnimationFrame(render)
    if (document.hidden || !visible || timestamp - lastFrame < frameInterval) return
    lastFrame = timestamp - ((timestamp - lastFrame) % frameInterval)

    const nextRatio = Math.min(globalThis.devicePixelRatio || 1, lowPowerDevice ? 0.8 : 1)
    const nextWidth = Math.round(canvas.clientWidth * nextRatio)
    const nextHeight = Math.round(canvas.clientHeight * nextRatio)
    if (nextWidth !== width || nextHeight !== height) {
      width = nextWidth
      height = nextHeight
      canvas.width = width
      canvas.height = height
    }

    pointer.smoothX += (pointer.x - pointer.smoothX) * fluidParams.mouseSmoothing
    pointer.smoothY += (pointer.y - pointer.smoothY) * fluidParams.mouseSmoothing
    pointer.smoothVelocityX +=
      ((pointer.x - pointer.smoothX) * 0.5 - pointer.smoothVelocityX) * fluidParams.mouseVelocity
    pointer.smoothVelocityY +=
      ((pointer.y - pointer.smoothY) * 0.5 - pointer.smoothVelocityY) * fluidParams.mouseVelocity

    const previous = useFirst ? targetA : targetB
    const next = useFirst ? targetB : targetA
    useFirst = !useFirst

    gl.bindFramebuffer(gl.FRAMEBUFFER, next.framebuffer)
    gl.viewport(0, 0, flowWidth, flowHeight)
    gl.useProgram(flowProgram)
    bindPosition(flowProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, previous.texture)
    gl.uniform1i(flowUniforms.prev, 0)
    gl.uniform2f(flowUniforms.mouse, pointer.smoothX, pointer.smoothY)
    gl.uniform2f(
      flowUniforms.velocity,
      pointer.smoothVelocityX,
      pointer.smoothVelocityY,
    )
    gl.uniform1f(flowUniforms.brushRadius, fluidParams.mouseRadius)
    gl.uniform1f(flowUniforms.brushStrength, interactive ? fluidParams.mouseStrength : 0)
    gl.uniform1f(flowUniforms.decay, fluidParams.decay)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, width, height)
    gl.useProgram(fluidProgram)
    bindPosition(fluidProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, next.texture)
    gl.uniform1i(fluidUniforms.flowmap, 0)
    gl.uniform1f(
      fluidUniforms.time,
      (timestamp - startedAt) * 0.001 * (fluidParams.speed / 100),
    )
    gl.uniform2f(fluidUniforms.resolution, width, height)
    gl.uniform1f(fluidUniforms.scale, fluidParams.scale)
    gl.uniform2f(fluidUniforms.offset, fluidParams.offsetX / 100, fluidParams.offsetY / 100)
    gl.uniform1f(fluidUniforms.grain, fluidParams.grain)
    gl.uniform1f(fluidUniforms.distortBoost, fluidParams.distortBoost)
    gl.uniform1f(fluidUniforms.swirlBoost, fluidParams.swirlBoost)
    gl.uniform1f(fluidUniforms.glowIntensity, fluidParams.glowIntensity)
    gl.uniform2f(
      fluidUniforms.lightPos,
      fluidParams.lightX + (pointer.smoothX - fluidParams.lightX) * (interactive ? fluidParams.lightFollow : 0),
      fluidParams.lightY,
    )
    gl.uniform1f(fluidUniforms.lightCore, coarsePointer ? 0 : fluidParams.lightCore)
    gl.uniform1f(fluidUniforms.lightHalo, coarsePointer ? 0 : fluidParams.lightHalo)
    gl.uniform1f(fluidUniforms.vignette, fluidParams.vignette)
    gl.uniform1f(fluidUniforms.bloomThreshold, fluidParams.bloomThreshold)
    gl.uniform1f(fluidUniforms.bloomRange, fluidParams.bloomRange)
    gl.uniform1f(fluidUniforms.bloomStrength, fluidParams.bloomStrength)

    fluidParams.glowColors.forEach((color, index) => {
      const rgb = colorToRgb(color)
      gl.uniform3f(fluidUniforms[`glowColor${index + 1}`], rgb[0], rgb[1], rgb[2])
    })
    fluidParams.colors.forEach((color, index) => {
      const rgb = colorToRgb(color)
      gl.uniform3f(fluidUniforms[`c${index + 1}`], rgb[0], rgb[1], rgb[2])
    })
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    if (!revealed) {
      revealed = true
      document.body.classList.add('is-fluid-ready')
    }
  }

  const observer = new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting
    },
    { threshold: 0 },
  )
  observer.observe(canvas)
  globalThis.requestAnimationFrame(render)
}
