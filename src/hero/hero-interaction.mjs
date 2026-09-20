// 鲸鱼粒子场景的交互与生命周期：指针、可见性、设备能力与启动编排。
import { createPixelData } from '../hero-pixels.mjs'
import { createHeroScene } from './hero-scene.mjs'

const lowPowerDevice =
  (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
  (navigator.deviceMemory && navigator.deviceMemory <= 4)

// 指针与可见性状态。渲染循环只读取，事件回调负责写入。
export function createHeroInteraction(stage) {
  const pointer = { x: 0, y: 0, active: false, moved: false }
  const state = { visible: true }

  function updatePointer(event) {
    pointer.active = true
    pointer.moved = true
    const bounds = stage.getBoundingClientRect()
    pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1
    pointer.y = -(((event.clientY - bounds.top) / bounds.height) * 2 - 1)
  }

  function deactivatePointer() {
    pointer.active = false
  }

  function handleVisibilityChange() {
    if (document.hidden) pointer.active = false
  }

  return {
    pointer,
    isVisible: () => state.visible,
    attach() {
      globalThis.addEventListener('mousemove', updatePointer, { passive: true })
      globalThis.addEventListener('mouseleave', deactivatePointer)
      document.addEventListener('visibilitychange', handleVisibilityChange)
    },
    observeIntersection() {
      const observer = new IntersectionObserver(
        ([entry]) => {
          state.visible = entry.isIntersecting
        },
        { rootMargin: '100px' },
      )
      observer.observe(stage)
    },
  }
}

// 建立交互、加载粒子源图，就绪后组装场景。WebGL 不可用时（远程桌面、软件渲染
// 初始化失败）只放弃这段装饰动画，不让异常冒泡打断启动页的其余脚本。
export function initializeHeroWhale(THREE, stage) {
  const interaction = createHeroInteraction(stage)
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.addEventListener(
    'load',
    () => {
      try {
        createHeroScene(THREE, {
          stage,
          pixelData: createPixelData(image, 60),
          interaction,
          lowPowerDevice,
        })
      } catch (error) {
        console.warn('[hero-whale] unable to build the scene', error)
      }
    },
    { once: true },
  )
  image.src = new URL('../assets/brand/hero-whale.svg', import.meta.url).href
  interaction.attach()
}
