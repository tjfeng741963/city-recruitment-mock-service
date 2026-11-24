<template>
  <section class="flow-canvas-shell" :class="{ 'is-readonly': readonly }" aria-label="招聘流程画布">
    <div class="canvas-toolbar">
      <span class="canvas-caption">{{ flow.nodes.length }} 个节点 · {{ flow.edges.length }} 条连接</span>
      <div class="zoom-controls" aria-label="画布缩放">
        <el-button size="small" :icon="Minus" :disabled="zoom <= 0.25" @click="zoomBy(-0.1)">缩小</el-button>
        <el-slider :model-value="zoomPercent" :min="25" :max="150" :step="5" :format-tooltip="(value: number) => `${value}%`" aria-label="画布缩放比例" @update:model-value="setZoomPercent" />
        <span class="zoom-value" aria-live="polite">{{ zoomPercent }}%</span>
        <el-button size="small" :icon="Plus" :disabled="zoom >= 1.5" @click="zoomBy(0.1)">放大</el-button>
        <el-button size="small" @click="setZoom(1)">重置缩放</el-button>
        <el-button size="small" :icon="FullScreen" @click="fitToCanvas">适配画布</el-button>
      </div>
    </div>

    <div
      ref="viewport"
      class="flow-viewport"
      :class="{ 'is-panning': Boolean(pan) }"
      tabindex="0"
      aria-label="流程画布，拖动空白平移，Ctrl 或 Command 加滚轮缩放"
      @pointerdown="beginPan"
      @pointermove="movePan"
      @pointerup="endPan"
      @pointercancel="endPan"
      @wheel="onWheel"
    >
      <div class="flow-spacer" :style="spacerStyle">
        <div class="flow-scene" :style="sceneStyle">
          <svg class="flow-edges" :width="scene.width" :height="scene.height" :viewBox="`0 0 ${scene.width} ${scene.height}`" aria-label="流程连接">
            <defs>
              <marker id="agent-flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--el-color-primary)" />
              </marker>
            </defs>
            <g v-for="(edge, index) in flow.edges" :key="`${edge.from_key}-${edge.trigger}-${index}`">
              <path
                :d="edgeGeometry(edge).path"
                class="edge-visible"
                :class="{ selected: selectedEdgeIndex === index }"
                marker-end="url(#agent-flow-arrow)"
              />
              <path
                :d="edgeGeometry(edge).path"
                class="edge-hit"
                :aria-label="`选择连接 ${edge.from_key} ${triggerLabel(edge.trigger)}`"
                tabindex="0"
                @click.stop="emit('select-edge', index)"
                @keydown.enter.stop="emit('select-edge', index)"
              />
              <text
                :x="edgeGeometry(edge).labelX"
                :y="edgeGeometry(edge).labelY"
                class="edge-label"
                :class="{ selected: selectedEdgeIndex === index }"
                @click.stop="emit('select-edge', index)"
              >{{ edge.runtime_label || `${triggerLabel(edge.trigger)}${edge.condition_value ? ` · ${edge.condition_value}` : ''}` }}</text>
            </g>
          </svg>

          <div
            v-for="(node, index) in flow.nodes"
            :key="node.node_key"
            class="flow-node"
            :class="[
              `node-${node.node_type}`,
              { selected: selectedNodeKey === node.node_key, disabled: node.status === 'disabled' },
            ]"
            :style="nodeStyle(node, index)"
            role="button"
            tabindex="0"
            :aria-label="`${node.title || node.node_key}，${nodeTypeLabel(node.node_type)}`"
            @pointerdown="beginDrag($event, node, index)"
            @pointermove="moveDrag($event)"
            @pointerup="endDrag($event)"
            @pointercancel="endDrag($event)"
            @click.stop="selectNode(node.node_key)"
            @keydown.enter.stop="selectNode(node.node_key)"
          >
            <div class="node-heading">
              <span class="node-title">{{ node.title || node.node_key }}</span>
              <el-tag size="small" effect="plain" :type="node.status === 'disabled' ? 'info' : 'primary'">
                {{ nodeContentLabel(node) }}
              </el-tag>
            </div>
            <FlowMediaPreview v-if="previewPart(node)" :name="previewPart(node)!.media_name!" :kind="previewPart(node)!.kind" compact @preview="selectNode(node.node_key)" />
            <div class="node-summary">{{ nodeSummary(node) }}</div>
            <div class="node-footer">
              <span>{{ nodeExecutionLabel(node) }}</span>
              <span v-if="node.node_key === flow.entry_key" class="entry-label">流程入口</span>
              <span v-else-if="node.status === 'disabled'">已停用</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="canvas-hint">拖动空白平移 · Ctrl / ⌘ + 滚轮缩放 · {{ readonly ? '点击节点查看执行说明' : '拖动节点调整位置，点击节点或连线编辑' }}</div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { FullScreen, Minus, Plus } from '@element-plus/icons-vue'
import type { AgentFlow, AgentFlowEdge, AgentFlowNode } from '../../api/agent'
import { dragFlowPoint } from '../basic/flow-graph'
import FlowMediaPreview from './FlowMediaPreview.vue'
import { fitCanvasZoom, panCanvasScroll, zoomCanvasAt } from './canvas-navigation'

const NODE_WIDTH = 272
const NODE_HEIGHT = 148
const SCENE_PADDING = 80

const props = defineProps<{
  flow: AgentFlow
  selectedNodeKey: string
  selectedEdgeIndex: number | null
  readonly?: boolean
}>()

const emit = defineEmits<{
  (event: 'select-node', nodeKey: string): void
  (event: 'select-edge', index: number): void
  (event: 'move-node', nodeKey: string, x: number, y: number): void
}>()

const viewport = ref<HTMLElement | null>(null)
const zoom = ref(1)
const zoomPercent = computed(() => Math.round(zoom.value * 100))
const viewportSize = ref({ width: 0, height: 0 })
const pan = ref<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
let observer: ResizeObserver | undefined
const drag = ref<{
  pointerId: number
  nodeKey: string
  originX: number
  originY: number
  pointerX: number
  pointerY: number
  moved: boolean
} | null>(null)

const positions = computed(() => props.flow.nodes.map((node, index) => ({
  key: node.node_key,
  x: finiteCoordinate(node.x, 48),
  y: finiteCoordinate(node.y, 48 + index * 184),
})))

const scene = computed(() => {
  const minX = Math.min(0, ...positions.value.map((node) => node.x))
  const minY = Math.min(0, ...positions.value.map((node) => node.y))
  const maxX = Math.max(0, ...positions.value.map((node) => node.x + NODE_WIDTH))
  const maxY = Math.max(0, ...positions.value.map((node) => node.y + NODE_HEIGHT))
  const offsetX = SCENE_PADDING - minX
  const offsetY = SCENE_PADDING - minY
  return {
    offsetX,
    offsetY,
    width: Math.max(760, maxX - minX + SCENE_PADDING * 2 + NODE_WIDTH),
    height: Math.max(500, maxY - minY + SCENE_PADDING * 2 + NODE_HEIGHT),
  }
})

const spacerStyle = computed(() => ({
  width: `${Math.max(viewportSize.value.width, scene.value.width * zoom.value)}px`,
  height: `${Math.max(viewportSize.value.height, scene.value.height * zoom.value)}px`,
}))

const sceneStyle = computed(() => ({
  width: `${scene.value.width}px`,
  height: `${scene.value.height}px`,
  transform: `scale(${zoom.value})`,
  left: `${Math.max(0, (viewportSize.value.width - scene.value.width * zoom.value) / 2)}px`,
  top: `${Math.max(0, (viewportSize.value.height - scene.value.height * zoom.value) / 2)}px`,
}))

const labels: Record<string, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  followup: '复聊',
  branch: '分支',
  end: '结束',
  system_start: '客户进入',
  system_ai: 'AI 答疑',
}

const triggerLabels: Record<string, string> = {
  default: '继续',
  any_reply: '客户回复',
  timeout: '超时',
  keyword: '关键词',
  giveup: '放弃',
}

function finiteCoordinate(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function graphPosition(node: AgentFlowNode, index: number) {
  return positions.value[index] ?? { key: node.node_key, x: 48, y: 48 + index * 184 }
}

function nodeStyle(node: AgentFlowNode, index: number) {
  const point = graphPosition(node, index)
  return {
    left: `${scene.value.offsetX + point.x}px`,
    top: `${scene.value.offsetY + point.y}px`,
    width: `${NODE_WIDTH}px`,
    height: `${NODE_HEIGHT}px`,
  }
}

function edgeGeometry(edge: AgentFlowEdge) {
  const sourceIndex = props.flow.nodes.findIndex((node) => node.node_key === edge.from_key)
  const source = sourceIndex < 0 ? { x: 0, y: 0 } : graphPosition(props.flow.nodes[sourceIndex], sourceIndex)
  const sourceCenter = {
    x: scene.value.offsetX + source.x + NODE_WIDTH / 2,
    y: scene.value.offsetY + source.y + NODE_HEIGHT / 2,
  }
  const targetIndex = props.flow.nodes.findIndex((node) => node.node_key === edge.to_key)
  let end: { x: number; y: number }
  if (targetIndex >= 0) {
    const target = graphPosition(props.flow.nodes[targetIndex], targetIndex)
    end = {
      x: scene.value.offsetX + target.x + NODE_WIDTH / 2,
      y: scene.value.offsetY + target.y + NODE_HEIGHT / 2,
    }
  } else {
    end = { x: sourceCenter.x + NODE_WIDTH / 2 + 92, y: sourceCenter.y }
  }

  const horizontal = Math.abs(end.x - sourceCenter.x) > Math.abs(end.y - sourceCenter.y)
  const start = horizontal
    ? { x: sourceCenter.x + Math.sign(end.x - sourceCenter.x) * NODE_WIDTH / 2, y: sourceCenter.y }
    : { x: sourceCenter.x, y: sourceCenter.y + Math.sign(end.y - sourceCenter.y || 1) * NODE_HEIGHT / 2 }
  const finish = targetIndex < 0 ? end : horizontal
    ? { x: end.x - Math.sign(end.x - sourceCenter.x) * NODE_WIDTH / 2, y: end.y }
    : { x: end.x, y: end.y - Math.sign(end.y - sourceCenter.y) * NODE_HEIGHT / 2 }
  const distance = horizontal ? Math.abs(finish.x - start.x) : Math.abs(finish.y - start.y)
  const bend = Math.max(36, Math.min(112, distance * 0.42))
  const c1 = horizontal
    ? { x: start.x + Math.sign(finish.x - start.x) * bend, y: start.y }
    : { x: start.x, y: start.y + Math.sign(finish.y - start.y || 1) * bend }
  const c2 = horizontal
    ? { x: finish.x - Math.sign(finish.x - start.x) * bend, y: finish.y }
    : { x: finish.x, y: finish.y - Math.sign(finish.y - start.y || 1) * bend }
  return {
    path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${finish.x} ${finish.y}`,
    labelX: (start.x + finish.x) / 2,
    labelY: (start.y + finish.y) / 2 - 8,
  }
}

function triggerLabel(trigger: string): string {
  return triggerLabels[trigger] || trigger
}

function nodeTypeLabel(nodeType: string): string {
  if (nodeType === 'favorite_location') return '企微位置卡'
  return labels[nodeType] || nodeType
}

function nodeContentLabel(node: AgentFlowNode): string {
  if (['branch', 'end', 'followup', 'system_start', 'system_ai'].includes(node.node_type)) return nodeTypeLabel(node.node_type)
  const kinds = [...new Set((node.parts || []).map((part) => part.kind))]
  return kinds.length ? kinds.map(nodeTypeLabel).join(' + ') : nodeTypeLabel(node.node_type)
}

function previewPart(node: AgentFlowNode) {
  return node.parts?.find(part => ['image', 'video'].includes(part.kind) && part.media_name)
}

function nodeSummary(node: AgentFlowNode): string {
  if (node.node_type.startsWith('system_')) return String(node.body || '')
  if (node.node_type === 'branch') return '按关键词或默认条件分流'
  if (node.node_type === 'end') return '流程到此结束'
  const parts = Array.isArray(node.parts) ? node.parts : []
  const preview = parts.map((part) => {
    if (part.kind === 'text') return part.body
    if (part.kind === 'favorite_location') return `${part.interview_point || '未选面试点'}（位置卡待接入）`
    return part.media_name ? `${nodeTypeLabel(part.kind)}：${part.media_name}` : '未选素材'
  })
    .filter(Boolean)
    .slice(0, 2)
    .join(' / ')
  return preview || '尚未配置内容'
}

function nodeExecutionLabel(node: AgentFlowNode): string {
  if (node.status === 'disabled') return '跳过内容与等待'
  if (node.node_type === 'system_start') return '满足首次触发条件'
  if (node.node_type === 'system_ai') return '按客户问题生成回复'
  if (node.node_type === 'system_media') return 'AI 按需选择 · 非固定顺序'
  if (node.node_type === 'end') return '固定流程结束'
  if (node.node_type === 'branch') return '关键词优先，否则走默认'
  if (node.node_type === 'followup') return '超时后发送 · 最多 1 次'
  return node.await_reply ? `发完等待客户回复 · ${node.wait_minutes || 15} 分钟` : '发送后沿连接继续'
}

function selectNode(nodeKey: string): void {
  drag.value = null
  emit('select-node', nodeKey)
}

function beginDrag(event: PointerEvent, node: AgentFlowNode, index: number): void {
  if (event.button !== 0) return
  event.stopPropagation()
  if (props.readonly) {
    emit('select-node', node.node_key)
    return
  }
  const point = graphPosition(node, index)
  drag.value = {
    pointerId: event.pointerId,
    nodeKey: node.node_key,
    originX: point.x,
    originY: point.y,
    pointerX: event.clientX,
    pointerY: event.clientY,
    moved: false,
  }
  emit('select-node', node.node_key)
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function moveDrag(event: PointerEvent): void {
  if (props.readonly) return
  const current = drag.value
  if (!current || current.pointerId !== event.pointerId) return
  if (!current.moved && Math.hypot(event.clientX - current.pointerX, event.clientY - current.pointerY) < 3) return
  current.moved = true
  const point = dragFlowPoint(
    { x: current.originX, y: current.originY },
    { x: current.pointerX, y: current.pointerY },
    { x: event.clientX, y: event.clientY },
    zoom.value,
  )
  emit('move-node', current.nodeKey, Math.round(point.x), Math.round(point.y))
}

function endDrag(event: PointerEvent): void {
  if (drag.value?.pointerId === event.pointerId) drag.value = null
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
}

function fitToCanvas(): void {
  const host = viewport.value
  if (!host) return
  zoom.value = fitCanvasZoom(scene.value, { width: host.clientWidth, height: host.clientHeight })
  nextTick(() => host.scrollTo({ left: 0, top: 0, behavior: 'smooth' }))
}

function setZoom(value: number, anchor?: { x: number; y: number }): void {
  const host = viewport.value
  if (!host) return
  const nextZoom = Math.max(0.25, Math.min(1.5, value))
  const result = zoomCanvasAt({
    zoom: zoom.value, nextZoom,
    scrollLeft: host.scrollLeft, scrollTop: host.scrollTop,
    anchorX: anchor?.x ?? host.clientWidth / 2,
    anchorY: anchor?.y ?? host.clientHeight / 2,
    originX: Math.max(0, (host.clientWidth - scene.value.width * zoom.value) / 2),
    originY: Math.max(0, (host.clientHeight - scene.value.height * zoom.value) / 2),
    nextOriginX: Math.max(0, (host.clientWidth - scene.value.width * nextZoom) / 2),
    nextOriginY: Math.max(0, (host.clientHeight - scene.value.height * nextZoom) / 2),
  })
  zoom.value = result.zoom
  nextTick(() => host.scrollTo({ left: result.scrollLeft, top: result.scrollTop }))
}

function setZoomPercent(value: number | number[]): void {
  if (typeof value === 'number') setZoom(value / 100)
}

function zoomBy(delta: number): void {
  setZoom(Math.round((zoom.value + delta) * 100) / 100)
}

function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  const host = viewport.value
  if (!host) return
  const rect = host.getBoundingClientRect()
  setZoom(zoom.value * Math.exp(-event.deltaY * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top })
}

function beginPan(event: PointerEvent): void {
  if (event.button !== 0 || (event.target as Element).closest('.flow-node, .edge-hit, .edge-label')) return
  const host = viewport.value
  if (!host) return
  pan.value = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: host.scrollLeft, top: host.scrollTop }
  host.setPointerCapture(event.pointerId)
}

function movePan(event: PointerEvent): void {
  const current = pan.value
  if (!current || current.pointerId !== event.pointerId || !viewport.value) return
  const point = panCanvasScroll({ left: current.left, top: current.top }, current, { x: event.clientX, y: event.clientY })
  viewport.value.scrollTo(point.left, point.top)
}

function endPan(event: PointerEvent): void {
  const host = viewport.value
  if (pan.value?.pointerId === event.pointerId) pan.value = null
  if (host?.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId)
}

onMounted(() => {
  if (!viewport.value) return
  observer = new ResizeObserver(([entry]) => {
    if (entry) viewportSize.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  observer.observe(viewport.value)
})

onBeforeUnmount(() => observer?.disconnect())

defineExpose({ fitToCanvas, setZoom, zoomBy, zoomPercent })
</script>

<style scoped>
.flow-canvas-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  background: var(--el-bg-color-page, #f5f7fb);
}

.canvas-toolbar {
  display: flex;
  min-height: 42px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--el-border-color-light);
  background: var(--el-bg-color);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.zoom-controls { display: flex; align-items: center; gap: 6px; }
.zoom-controls :deep(.el-button + .el-button) { margin-left: 0; }
.zoom-controls :deep(.el-slider) { width: 104px; margin: 0 6px; }
.zoom-value { min-width: 39px; color: var(--el-text-color-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }

.canvas-caption {
  min-width: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.flow-viewport {
  flex: 1;
  width: 100%;
  height: min(68vh, 760px);
  min-height: 200px;
  overflow: auto;
  overscroll-behavior: contain;
  cursor: grab;
  touch-action: none;
}

.flow-viewport.is-panning { cursor: grabbing; user-select: none; }
.canvas-hint { padding: 6px 10px; border-top: 1px solid var(--el-border-color-light); color: var(--el-text-color-secondary); background: var(--el-bg-color); font-size: 11px; flex-shrink: 0; }

.flow-spacer {
  position: relative;
}

.flow-scene {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: top left;
  background-color: var(--el-bg-color-page, #f5f7fb);
  background-image: radial-gradient(var(--el-border-color) 0.7px, transparent 0.7px);
  background-size: 20px 20px;
}

.flow-edges {
  position: absolute;
  z-index: 0;
  inset: 0;
  overflow: visible;
}

.edge-visible {
  fill: none;
  stroke: var(--el-color-primary-light-3);
  stroke-width: 2;
  pointer-events: none;
}

.edge-visible.selected {
  stroke: var(--el-color-primary);
  stroke-width: 3;
}

.edge-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 18;
  cursor: pointer;
  pointer-events: stroke;
}

.edge-hit:focus-visible {
  outline: none;
  stroke: color-mix(in srgb, var(--el-color-primary) 18%, transparent);
}

.edge-label {
  fill: var(--el-text-color-secondary);
  stroke: var(--el-bg-color-page, #f5f7fb);
  stroke-width: 5px;
  paint-order: stroke;
  text-anchor: middle;
  font-size: 12px;
  cursor: pointer;
  pointer-events: visiblePainted;
}

.edge-label.selected {
  fill: var(--el-color-primary);
  font-weight: 600;
}

.flow-node {
  position: absolute;
  z-index: 1;
  display: flex;
  flex-direction: column;
  padding: 12px;
  overflow: hidden;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-bg-color);
  box-shadow: var(--el-box-shadow-light);
  color: var(--el-text-color-primary);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.flow-node:active {
  cursor: grabbing;
}

.flow-node:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.flow-node.selected {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-8);
}

.flow-node.disabled {
  opacity: 0.62;
}

.is-readonly .flow-node,
.is-readonly .flow-node:active { cursor: pointer; }
.node-system_start,
.node-system_ai { border-style: dashed; background: var(--el-color-primary-light-9); }
.entry-label { color: var(--el-color-primary); }

.node-heading,
.node-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.node-title {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-summary {
  display: -webkit-box;
  flex: 1;
  margin: 10px 0;
  overflow: hidden;
  color: var(--el-text-color-regular);
  font-size: 12px;
  line-height: 1.5;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow-wrap: anywhere;
}

.node-footer {
  justify-content: flex-start;
  color: var(--el-text-color-secondary);
  font-size: 11px;
}

@media (max-width: 700px) {
  .zoom-controls { flex-wrap: wrap; gap: 4px; }
  .zoom-controls :deep(.el-slider) { width: 72px; }
  .flow-viewport {
    min-height: 200px;
  }
}
</style>
