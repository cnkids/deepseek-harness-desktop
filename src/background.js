import { startFluid } from './loading/fluid-visual.mjs'
import { startGrid } from './loading/grid-visual.mjs'

// 启动页背景视觉入口：判定用户偏好与设备能力后，按原时序启动流体与网格。
const fluidCanvas = document.querySelector('#fluid-canvas')
const gridCanvas = document.querySelector('#grid-canvas')
const reducedMotion = globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
const lowPowerDevice =
  (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
  (navigator.deviceMemory && navigator.deviceMemory <= 4)

let started = false
function startVisuals() {
  if (started) return
  started = true
  if (reducedMotion) return

  const startFluidWhenIdle = () => startFluid(fluidCanvas, { lowPowerDevice })
  globalThis.setTimeout(() => {
    if ('requestIdleCallback' in globalThis) {
      globalThis.requestIdleCallback(startFluidWhenIdle, { timeout: 320 })
    } else {
      startFluidWhenIdle()
    }
  }, 160)

  // The grid is secondary decoration. Staggering it keeps its canvas setup
  // away from the fluid shader compilation and the page entry transition.
  if (!reducedMotion && !lowPowerDevice) {
    globalThis.setTimeout(() => startGrid(gridCanvas), 650)
  }
}

globalThis.addEventListener('startup-shell-ready', startVisuals, { once: true })
// Fallback for unusual script scheduling where the custom event was emitted
// before this listener was installed.
globalThis.setTimeout(startVisuals, 800)
