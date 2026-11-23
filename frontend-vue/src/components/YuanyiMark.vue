<template>
  <svg
    ref="artwork"
    class="yuanyi-mark"
    xmlns="http://www.w3.org/2000/svg"
    :viewBox="animated ? '20 13 365 250' : '39 26 325 166'"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : true"
  >
    <defs>
      <linearGradient :id="id('route')" gradientUnits="userSpaceOnUse" x1="68" y1="164" x2="350" y2="96">
        <stop stop-color="#404975" />
        <stop offset=".24" stop-color="#4b899f" />
        <stop offset=".42" stop-color="#5982b6" />
        <stop offset=".68" stop-color="#66bdbb" />
        <stop offset=".86" stop-color="#6a9fc5" />
        <stop offset="1" stop-color="#8268b5" />
      </linearGradient>
      <linearGradient :id="id('origin')" x2=".84" y2="1">
        <stop stop-color="#444e7a" /><stop offset="1" stop-color="#303a64" />
      </linearGradient>
      <linearGradient :id="id('cyan')" x2=".84" y2="1">
        <stop stop-color="#79c7c6" /><stop offset="1" stop-color="#55a8b5" />
      </linearGradient>
      <linearGradient :id="id('blue')" x2=".84" y2="1">
        <stop stop-color="#6f95c9" /><stop offset="1" stop-color="#4e67aa" />
      </linearGradient>
      <linearGradient :id="id('purple')" x2=".84" y2="1">
        <stop stop-color="#917cc8" /><stop offset="1" stop-color="#735bb0" />
      </linearGradient>
    </defs>
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path ref="threadOne" pathLength="1" stroke="#8b9bab" stroke-opacity=".63" stroke-width="1.1" d="M127 159h23c27 0 34-25 60-25s33 26 63 26" />
      <path ref="threadTwo" pathLength="1" stroke="#8cb7b8" stroke-opacity=".58" stroke-width="1.1" d="M123 165h29c29 0 33-24 59-24 25 0 33 25 61 25" />
      <path ref="route" pathLength="1" :stroke="ink('route')" stroke-width="9.25" d="M68 162H128C149 162 160 141 182 111S226 61 251 54C263 51 268 53 273 53C311 53 337 74 337 103C337 140 307 163 275 163" />
    </g>
    <g ref="nodes" stroke="#f5f3ed" stroke-width="1.5">
      <circle cx="68" cy="162" r="24" :fill="ink('origin')" />
      <circle cx="128" cy="162" r="18" :fill="ink('cyan')" />
      <circle cx="182" cy="111" r="18" :fill="ink('blue')" />
      <circle cx="273" cy="53" r="18.5" :fill="ink('cyan')" />
      <circle cx="337" cy="103" r="18" :fill="ink('purple')" />
    </g>
    <text v-if="animated" ref="wordmark" class="yuanyi-wordmark" x="339" y="240" text-anchor="end">源绎</text>
  </svg>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'

const props = defineProps<{ animated?: boolean; label?: string }>()
const uid = useId()
const id = (name: string) => `yuanyi-${uid}-${name}`
const ink = (name: string) => `url(#${id(name)})`
const artwork = ref<SVGSVGElement | null>(null)
const route = ref<SVGPathElement | null>(null)
const threadOne = ref<SVGPathElement | null>(null)
const threadTwo = ref<SVGPathElement | null>(null)
const nodes = ref<SVGGElement | null>(null)
const wordmark = ref<SVGTextElement | null>(null)

const duration = 2350
const clamp = (value: number) => Math.min(1, Math.max(0, value))
const ease = (value: number) => value * value * (3 - 2 * value)
const range = (value: number, start: number, end: number) => clamp((value - start) / (end - start))
let frame = 0
let finishMotion: (() => void) | undefined

onMounted(() => {
  const svg = artwork.value
  const mainPath = route.value
  const threads = [threadOne.value, threadTwo.value]
  const title = wordmark.value
  if (!props.animated || !svg || !mainPath || !nodes.value || !title) return
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  if (motion.matches) return

  const circles = Array.from(nodes.value.querySelectorAll('circle'))
  const length = mainPath.getTotalLength()
  if (!length) return
  const sampleCount = 480
  const points = Array.from({ length: sampleCount + 1 }, (_, index) =>
    mainPath.getPointAtLength(index / sampleCount * length))
  const nodePositions = circles.map((node) => {
    let closestIndex = 0
    let closestDistance = Infinity
    points.forEach((point, index) => {
      const distance = (point.x - node.cx.baseVal.value) ** 2 + (point.y - node.cy.baseVal.value) ** 2
      if (distance < closestDistance) {
        closestIndex = index
        closestDistance = distance
      }
    })
    return closestIndex / sampleCount
  })

  function trace(path: SVGPathElement | null, progress: number): void {
    if (!path) return
    path.style.strokeDasharray = '1'
    path.style.strokeDashoffset = String(1 - progress)
    path.style.opacity = String(clamp(progress / .012))
  }

  function draw(time: number): void {
    const progress = ease(range(time, 60, 1980))
    trace(mainPath, progress)
    trace(threads[0] ?? null, ease(range(time, 490, 1900)))
    trace(threads[1] ?? null, ease(range(time, 570, 1990)))
    circles.forEach((node, index) => {
      const position = nodePositions[index] ?? 0
      const reveal = index === 0
        ? ease(range(time, 0, 345))
        : ease(range(progress, position - .024, position + .064))
      node.style.opacity = String(reveal)
      node.style.transform = `scale(${.88 + .12 * reveal})`
    })
    const settle = ease(range(time, 1190, duration))
    if (title) {
      title.style.opacity = String(settle)
      title.style.transform = `translateY(${7 * (1 - settle)}px)`
    }
  }

  function finish(): void {
    cancelAnimationFrame(frame)
    motion.removeEventListener('change', stopOnPreferenceChange)
    for (const part of [mainPath, ...threads, ...circles, title]) part?.removeAttribute('style')
    svg?.removeAttribute('data-playing')
    finishMotion = undefined
  }

  function stopOnPreferenceChange(event: MediaQueryListEvent): void {
    if (event.matches) finish()
  }

  finishMotion = finish
  motion.addEventListener('change', stopOnPreferenceChange)
  svg.setAttribute('data-playing', '')
  draw(0)
  let start: number | undefined
  function tick(now: number): void {
    start ??= now
    const elapsed = now - start
    if (elapsed >= duration) {
      finish()
      return
    }
    draw(elapsed)
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
})

onBeforeUnmount(() => finishMotion?.())
</script>

<style scoped>
.yuanyi-mark {
  display: block;
  height: auto;
  width: 100%;
  overflow: visible;
}

.yuanyi-mark circle {
  transform-box: fill-box;
  transform-origin: center;
}

.yuanyi-wordmark {
  fill: #26314f;
  font-size: 59px;
  font-weight: 660;
  letter-spacing: 2px;
}
</style>
