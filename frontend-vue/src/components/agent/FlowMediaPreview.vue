<template>
  <div class="flow-media-preview" :class="{ compact }" @pointerdown.stop @click.stop>
    <div v-if="loading" class="preview-placeholder">加载{{ kind === 'video' ? '视频' : '图片' }}…</div>
    <div v-else-if="error" class="preview-placeholder">
      <span>{{ error }}</span><el-button v-if="!compact" link type="primary" @click="load">重试预览</el-button>
    </div>
    <template v-else-if="url">
      <button v-if="compact" class="thumbnail-button" :aria-label="`查看${kind === 'video' ? '视频' : '图片'} ${name}`" @click="$emit('preview')">
        <img v-if="kind === 'image'" :src="url" :alt="name" @error="error = '图片解码失败，请检查素材文件'" />
        <template v-else><video :src="url" muted preload="metadata" /><span class="video-badge">▶ 查看视频</span></template>
      </button>
      <el-image v-else-if="kind === 'image'" :src="url" :alt="name" fit="contain" :preview-src-list="[url]" preview-teleported @error="error = '图片解码失败，请检查素材文件'" />
      <video v-else :src="url" controls preload="metadata" :aria-label="`视频预览 ${name}`" @error="error = '视频解码失败，请检查素材文件'" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import http from '../../api/http'
const props = defineProps<{ name: string; kind: string; compact?: boolean }>()
defineEmits<{ (event: 'preview'): void }>()
const url = ref('')
const loading = ref(false)
const error = ref('')
let sequence = 0
let request: AbortController | null = null
function clear(): void {
  request?.abort()
  if (url.value) URL.revokeObjectURL(url.value)
  url.value = ''
}
async function load(): Promise<void> {
  const current = ++sequence
  clear()
  if (!props.name) return
  request = new AbortController()
  loading.value = true
  error.value = ''
  try {
    const { data } = await http.get<Blob>(`/api/v1/agent/media/${encodeURIComponent(props.name)}`, {responseType: 'blob', signal: request.signal})
    if (current !== sequence) return
    url.value = URL.createObjectURL(data)
  } catch (failure: any) {
    if (current !== sequence) return
    error.value = failure?.response?.status === 403 ? '没有素材预览权限' : '素材预览不可用'
  } finally { if (current === sequence) loading.value = false }
}
watch(() => [props.name, props.kind], load, { immediate: true })
onBeforeUnmount(() => { sequence += 1; clear() })
</script>

<style scoped>
.flow-media-preview { margin: 8px 0; min-width: 0; }
.flow-media-preview :deep(.el-image),.flow-media-preview > video { display: block; width: 100%; max-height: 280px; border-radius: 5px; background: var(--el-fill-color-light); }
.preview-placeholder { display: grid; gap: 4px; padding: 12px 6px; color: var(--el-text-color-secondary); font-size: 12px; text-align: center; background: var(--el-fill-color-light); }
.compact { margin: 3px 0; flex-shrink: 0; height: 42px; }
.compact .preview-placeholder { padding: 8px; }
.thumbnail-button { position: relative; width: 100%; height: 42px; padding: 0; overflow: hidden; border: 0; border-radius: 4px; background: var(--el-fill-color-light); cursor: pointer; }
.thumbnail-button img,.thumbnail-button video { width: 100%; height: 100%; object-fit: contain; }
.video-badge { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; background: #0005; font-size: 12px; }
</style>
