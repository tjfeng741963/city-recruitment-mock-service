<template>
  <div class="video-preview">
    <p v-if="preparing" role="status">正在准备兼容视频…</p>
    <p v-else-if="error" role="alert">{{ error }}</p>
    <video
      v-else
      :key="playbackUrl"
      :src="playbackUrl"
      :aria-label="label || `视频预览：${name}`"
      controls
      playsinline
      preload="metadata"
      @loadedmetadata="checkPicture"
      @error="prepareCompatible"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { isAxiosError } from 'axios'
import http from '../../api/http'

const props = defineProps<{ src: string; name: string; label?: string; version?: string }>()
const compatibleUrl = ref('')
const playbackUrl = computed(() => compatibleUrl.value || props.src)
const preparing = ref(false)
const error = ref('')
let request: AbortController | undefined

function checkPicture(event: Event): void {
  const video = event.currentTarget as HTMLVideoElement
  if (!video.videoWidth || !video.videoHeight) void prepareCompatible()
}

async function prepareCompatible(): Promise<void> {
  if (preparing.value || error.value) return
  if (compatibleUrl.value) {
    error.value = '此浏览器无法播放兼容视频，请换用其他浏览器。'
    return
  }

  const controller = new AbortController()
  request = controller
  preparing.value = true
  try {
    const { data } = await http.get<Blob>(`/api/v1/agent/media/${encodeURIComponent(props.name)}`, {
      params: { preview: 'compatible', version: props.version },
      responseType: 'blob',
      signal: controller.signal,
      timeout: 50_000,
    })
    if (!controller.signal.aborted) compatibleUrl.value = URL.createObjectURL(data)
  } catch (failure) {
    if (controller.signal.aborted) return
    const status = isAxiosError(failure) ? failure.response?.status : undefined
    error.value = status === 422
      ? '无法生成有画面的预览，请将视频导出为 H.264 MP4 后重新上传。'
      : '兼容预览暂不可用，请关闭后重新预览。'
  } finally {
    if (!controller.signal.aborted) preparing.value = false
  }
}

onBeforeUnmount(() => {
  request?.abort()
  if (compatibleUrl.value) URL.revokeObjectURL(compatibleUrl.value)
})
</script>

<style scoped>
.video-preview { width: 100%; min-width: 0; }
.video-preview video {
  display: block;
  width: 100%;
  max-height: var(--preview-video-height, 65vh);
  object-fit: contain;
  border-radius: 8px;
  background: #172032;
}
.video-preview p {
  margin: 0;
  padding: 24px 12px;
  text-align: center;
  overflow-wrap: anywhere;
}
</style>
