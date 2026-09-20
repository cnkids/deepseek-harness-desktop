// three.js 鲸鱼粒子场景：渲染器、实例化几何体、材质装配与渲染循环。
import { createRandomSource } from '../hero-pixels.mjs'
import { heroFragmentShader, heroVertexShader } from './hero-shaders.mjs'

const lightParams = {
  x: 4.5,
  y: 5.5,
  z: 3,
  range: 14,
  shadeMin: 0.2,
  shadeMax: 2.79 * 0.4,
  followX: 1.05,
}
const mouseParams = { radius: 4.9, strength: 0.8, decay: 0.2, distort: 5 }

function createRenderer(THREE, stage, lowPowerDevice) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: !lowPowerDevice })
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, lowPowerDevice ? 0.85 : 1.15))
  renderer.setSize(800, 800, false)
  renderer.domElement.dataset.engine = `three.js r${THREE.REVISION}`
  stage.appendChild(renderer.domElement)
  return renderer
}

function createGeometry(THREE, pixelData) {
  const indexArray = new Float32Array(pixelData.count)
  for (let index = 0; index < pixelData.count; index += 1) indexArray[index] = index

  const geometry = new THREE.BoxGeometry(0.06, 0.06, 0.018)
  geometry.setAttribute('aOpacity', new THREE.InstancedBufferAttribute(pixelData.opacities, 1))
  geometry.setAttribute('aIndex', new THREE.InstancedBufferAttribute(indexArray, 1))
  geometry.setAttribute(
    'aScattered',
    new THREE.InstancedBufferAttribute(pixelData.scatteredPositions, 3),
  )
  geometry.setAttribute('aEdge', new THREE.InstancedBufferAttribute(pixelData.edges, 1))
  return geometry
}

function createMaterial(THREE) {
  return new THREE.ShaderMaterial({
    vertexShader: heroVertexShader,
    fragmentShader: heroFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uWaveSpeed: { value: 1.5 },
      uWaveAmount: { value: 0.06 },
      uLightPos: { value: new THREE.Vector3(lightParams.x, lightParams.y, lightParams.z) },
      uLightRange: { value: lightParams.range },
      uShadeMin: { value: lightParams.shadeMin },
      uShadeMax: { value: lightParams.shadeMax },
      uColor: { value: new THREE.Color(0.75, 0.8, 0.9) },
      uMouse: { value: new THREE.Vector2(0, 0) },
      uMouseRadius: { value: 1.5 },
      uMouseStrength: { value: 0.4 },
      uMouseDistort: { value: 0.8 },
      uAssembly: { value: 0 },
      uLoose: { value: 0 },
      uScatter: { value: 0 },
    },
  })
}

function createMesh(THREE, geometry, material, pixelData) {
  const mesh = new THREE.InstancedMesh(geometry, material, pixelData.count)
  mesh.frustumCulled = false
  const dummy = new THREE.Object3D()
  const nextScaleJitter = createRandomSource()
  for (let index = 0; index < pixelData.count; index += 1) {
    dummy.position.set(
      pixelData.positions[index * 3],
      pixelData.positions[index * 3 + 1],
      pixelData.positions[index * 3 + 2],
    )
    const scale = 0.5 + nextScaleJitter()
    dummy.scale.set(scale, scale, scale)
    dummy.updateMatrix()
    mesh.setMatrixAt(index, dummy.matrix)
  }
  mesh.instanceMatrix.needsUpdate = true
  return mesh
}

// 每帧把动画状态写入 uniform：装配进度、指针张力、光照位置与漂浮姿态。
function updateSceneState(material, group, frame, elapsed, assembly) {
  const { pointer, stage, smoothedPointer, inverseWorld, localMouse } = frame
  material.uniforms.uTime.value = elapsed
  material.uniforms.uAssembly.value = assembly
  material.uniforms.uLoose.value = 1
  material.uniforms.uScatter.value = 0
  material.uniforms.uMouseRadius.value = mouseParams.radius
  material.uniforms.uMouseDistort.value = mouseParams.distort
  material.uniforms.uLightPos.value.set(
    lightParams.x + smoothedPointer.x * lightParams.followX,
    lightParams.y,
    lightParams.z,
  )

  const targetStrength = pointer.active ? mouseParams.strength : 0
  const currentStrength = material.uniforms.uMouseStrength.value
  material.uniforms.uMouseStrength.value +=
    (targetStrength - currentStrength) * (1 - 0.05 ** (1 / 30))

  if (pointer.moved) {
    const bounds = stage.getBoundingClientRect()
    const pointerX = pointer.x * (bounds.width / bounds.height) * 8.39
    const pointerY = pointer.y * 8.39
    if (currentStrength < 0.01) {
      smoothedPointer.set(pointerX, pointerY)
    } else {
      smoothedPointer.x += (pointerX - smoothedPointer.x) * mouseParams.decay
      smoothedPointer.y += (pointerY - smoothedPointer.y) * mouseParams.decay
    }
  }

  inverseWorld.copy(group.matrixWorld).invert()
  localMouse.set(smoothedPointer.x, smoothedPointer.y, 0).applyMatrix4(inverseWorld)
  material.uniforms.uMouse.value.set(localMouse.x, localMouse.y)

  const particleColor = assembly
  material.uniforms.uColor.value.setRGB(
    0.75 * particleColor,
    0.8 * particleColor,
    0.9 * particleColor,
  )
  group.rotation.z = 0.04 * Math.sin(0.25 * elapsed)
  group.rotation.x = 0.05 * Math.sin(0.08 * elapsed * 0.7)
  group.rotation.y = 0.1 * Math.sin(0.08 * elapsed)
  group.position.y = 0.15 * Math.sin(0.4 * elapsed)
  group.scale.setScalar(0.75 + 0.25 * assembly)
}

// 组装场景并启动渲染循环；指针与可见性由 hero-interaction 提供。
export function createHeroScene(THREE, { stage, pixelData, interaction, lowPowerDevice }) {
  const renderer = createRenderer(THREE, stage, lowPowerDevice)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 18)

  const geometry = createGeometry(THREE, pixelData)
  const material = createMaterial(THREE)
  const mesh = createMesh(THREE, geometry, material, pixelData)

  const group = new THREE.Group()
  group.add(mesh)
  scene.add(group)
  const inverseWorld = new THREE.Matrix4()
  const localMouse = new THREE.Vector3()
  const smoothedPointer = new THREE.Vector2(0, 0)
  const clock = new THREE.Clock()
  // Start assembly when the scene is actually ready. Previously this timer
  // began before Three.js and the SVG had loaded, so the reveal could jump to
  // its final state when startup was busy.
  const startedAt = performance.now()
  const frameInterval = 1000 / (lowPowerDevice ? 24 : 30)
  const frame = { pointer: interaction.pointer, stage, smoothedPointer, inverseWorld, localMouse }
  let lastFrame = 0

  function render(timestamp) {
    globalThis.requestAnimationFrame(render)
    if (!interaction.isVisible() || document.hidden || timestamp - lastFrame < frameInterval) return
    lastFrame = timestamp - ((timestamp - lastFrame) % frameInterval)

    const elapsed = clock.getElapsedTime()
    const assemblyElapsed = (timestamp - startedAt) * 0.001 - 0.3
    const linearAssembly = Math.max(0, Math.min(1, assemblyElapsed / 2.5))
    const assembly = 1 - (1 - linearAssembly) ** 3

    if (linearAssembly <= 0) {
      group.scale.setScalar(0)
    } else {
      updateSceneState(material, group, frame, elapsed, assembly)
    }

    renderer.render(scene, camera)
  }

  interaction.observeIntersection(stage)
  globalThis.requestAnimationFrame(render)
}
