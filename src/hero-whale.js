import { initializeHeroWhale } from './hero/hero-interaction.mjs'

// 鲸鱼粒子入口：判定启动条件后懒加载 three.js，再交给 hero-interaction 编排。
const stage = document.querySelector('#hero-whale-stage')
const reducedMotion = globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
let heroStarted = false

function startHeroWhale() {
  if (
    heroStarted ||
    !stage ||
    reducedMotion ||
    globalThis.matchMedia('(max-width: 767px)').matches
  ) {
    return
  }
  heroStarted = true

  const load = async () => {
    try {
      const THREE = await import('../node_modules/three/build/three.module.min.js')
      initializeHeroWhale(THREE, stage)
    } catch (error) {
      console.warn('[hero-whale] unable to start', error)
    }
  }

  globalThis.setTimeout(() => {
    if ('requestIdleCallback' in globalThis) {
      globalThis.requestIdleCallback(load, { timeout: 600 })
    } else {
      void load()
    }
  }, 380)
}

globalThis.addEventListener('startup-shell-ready', startHeroWhale, { once: true })
globalThis.setTimeout(startHeroWhale, 1_000)
