<template>
  <div class="loc-card">
    <div class="loc-map">
      <img
        v-for="tile in tiles"
        :key="tile.key"
        :src="tile.url"
        class="loc-tile"
        :style="{ left: tile.left + 'px', top: tile.top + 'px' }"
        alt=""
        loading="lazy"
        referrerpolicy="no-referrer"
        @error="failed = true"
      />
      <span class="loc-pin" aria-hidden="true" />
      <span v-if="!hasCoord || failed" class="loc-map-fallback">
        {{ hasCoord ? '地图暂不可用' : '缺坐标' }}
      </span>
      <span class="loc-credit">© OSM</span>
    </div>
    <div class="loc-text">
      <b>{{ name || '面试地点' }}</b>
      <span>{{ address || '未填地址' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * 位置卡预览（面试点/开场位置卡共用）。
 *
 * 用 OpenStreetMap 瓦片拼一张小地图：不需要 API key、不依赖高德控制台，
 * 只按经纬度算瓦片坐标。瓦片加载失败就退回「地图暂不可用」，
 * 地址文字始终可见——预览的意义是让运营一眼确认「这个点对不对」。
 */
const props = defineProps<{
  lng?: number | string | null
  lat?: number | string | null
  address?: string
  name?: string
}>()

const failed = ref(false)
const ZOOM = 16
const WIDTH = 232
const HEIGHT = 116

const coords = computed(() => {
  const lng = Number(props.lng)
  const lat = Number(props.lat)
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !lng || !lat) return null
  return { lng, lat }
})
const hasCoord = computed(() => coords.value !== null)

const tiles = computed(() => {
  const point = coords.value
  if (!point) return []
  const scale = 2 ** ZOOM
  const xf = ((point.lng + 180) / 360) * scale
  const rad = (point.lat * Math.PI) / 180
  const yf = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale
  const cx = Math.floor(xf)
  const cy = Math.floor(yf)
  const out: Array<{ key: string; url: string; left: number; top: number }> = []
  // 2×2 瓦片足够盖住 232×116 的窗口，并把目标点摆在正中
  for (const dx of [-1, 0]) {
    for (const dy of [-1, 0]) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= scale || y >= scale) continue
      out.push({
        key: `${ZOOM}/${x}/${y}`,
        url: `https://tile.openstreetmap.org/${ZOOM}/${x}/${y}.png`,
        left: Math.round(x * 256 - xf * 256 + WIDTH / 2),
        top: Math.round(y * 256 - yf * 256 + HEIGHT / 2),
      })
    }
  }
  return out
})
</script>

<style scoped>
.loc-card {
  display: flex;
  align-items: stretch;
  gap: 10px;
  padding: 8px;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 10px;
  background: #fff;
  max-width: 100%;
}
.loc-map {
  position: relative;
  width: 232px;
  height: 116px;
  flex: none;
  overflow: hidden;
  border-radius: 8px;
  background: #eef2f7;
}
.loc-tile {
  position: absolute;
  width: 256px;
  height: 256px;
  user-select: none;
}
.loc-pin {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  border-radius: 50%;
  background: #d93025;
  box-shadow: 0 0 0 4px rgba(217, 48, 37, 0.22);
}
.loc-map-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #8a94a6;
  background: rgba(238, 242, 247, 0.86);
}
.loc-credit {
  position: absolute;
  right: 4px;
  bottom: 2px;
  font-size: 9px;
  color: #7b8494;
  background: rgba(255, 255, 255, 0.72);
  padding: 0 3px;
  border-radius: 3px;
}
.loc-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  justify-content: center;
}
.loc-text b {
  font-size: 13px;
  color: var(--el-text-color-primary, #1f1f1f);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.loc-text span {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-regular, #606266);
  word-break: break-all;
}
@media (max-width: 640px) {
  .loc-card { flex-direction: column; }
  .loc-map { width: 100%; }
}
</style>
