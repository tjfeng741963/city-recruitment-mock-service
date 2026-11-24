<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">图片与视频</h2>
        <p class="page-desc">
          图 / 视频发给客户用。通用素材所有岗位共用；面试地点图这类各城市不同的，绑定到具体岗位——Agent 只会发本岗位绑定的图。
        </p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Upload" :loading="uploading" :disabled="!contextReady" @click="pickFile">
          上传素材
        </el-button>
        <input
          ref="fileInput"
          type="file"
          accept="image/*,video/*"
          class="hidden-input"
          @change="onFileChange"
        />
      </div>
    </div>

    <PositionContext @validated="applyPositionContext" />
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ items.length }}</div>
        <div class="stat-label">素材总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ imageCount }}</div>
        <div class="stat-label">图片</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ videoCount }}</div>
        <div class="stat-label">视频</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ generalCount }}</div>
        <div class="stat-label">通用素材</div>
      </div>
    </div>

    <div class="filter-bar">
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索素材名称..."
        clearable
        :prefix-icon="Search"
      />
      <el-select v-model="kindFilter" class="filter-select" placeholder="全部类型" clearable>
        <el-option label="全部类型" value="" />
        <el-option label="图片" value="image" />
        <el-option label="视频" value="video" />
      </el-select>
      <el-select v-model="bindFilter" class="filter-select" placeholder="全部绑定" clearable>
        <el-option label="全部绑定" value="" />
        <el-option label="通用（所有岗位）" value="general" />
        <el-option label="岗位专属" value="position" />
      </el-select>
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="paged" row-key="id">
        <template #empty>
          <el-empty description="暂无素材，点击右上角「上传素材」添加" />
        </template>
        <el-table-column label="素材" min-width="260">
          <template #default="{ row }">
            <div class="media-cell">
              <div class="media-thumb" :class="row.kind">
                <img
                  v-if="row.kind === 'image' && thumbUrls[row.id]"
                  :src="thumbUrls[row.id]"
                  :alt="row.name"
                />
                <el-icon v-else><Picture v-if="row.kind === 'image'" /><VideoCamera v-else /></el-icon>
              </div>
              <div class="media-meta">
                <div class="media-name">{{ row.name }}</div>
                <div class="media-sub">{{ row.sha256.slice(0, 12) }}…</div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag :type="row.kind === 'image' ? 'success' : 'warning'" effect="light">
              {{ row.kind === 'image' ? '图片' : '视频' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="110">
          <template #default="{ row }">{{ formatBytes(row.bytes) }}</template>
        </el-table-column>
        <el-table-column label="绑定岗位（改了即时生效）" min-width="240">
          <template #default="{ row }">
            <el-select
              :model-value="row.position_id || 0"
              class="binding-select"
              filterable
              @change="(value: number) => changeBinding(row, value)"
            >
              <el-option label="通用（所有岗位）" :value="0" />
              <el-option
                v-for="position in positions"
                :key="position.id"
                :label="position.position_name"
                :value="position.id"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="preview(row)">预览</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="filtered.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </div>

    <el-dialog v-model="previewVisible" :title="previewItem?.name || '预览'" width="720px" @close="clearPreview">
      <div class="preview-body" aria-live="polite">
        <el-empty v-if="previewError" :description="previewError" />
        <template v-else-if="previewItem && previewUrl">
          <video v-if="previewItem.kind === 'video'" :src="previewUrl" controls playsinline
            @error="previewError = '无法播放此视频，请检查文件或编码。'" />
          <img v-else :src="previewUrl" :alt="previewItem.name"
            @error="previewError = '无法显示此图片，请检查文件。'" />
        </template>
        <el-empty v-else-if="previewItem" description="素材内容加载中…" />
      </div>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import PositionContext from '../components/agent/PositionContext.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Picture, Refresh, Search, Upload, VideoCamera } from '@element-plus/icons-vue'
import http from '../api/http'
import { mediaApi, positionsApi } from '../api/core'
import type { PageResult, ServicePosition } from '../api/types'
import { formatBytes } from '../utils/format'

interface MediaRow {
  id: number
  name: string
  kind: 'image' | 'video' | string
  sha256: string
  bytes: number
  position_id: number
  position_name: string | null
}

const contextReady = ref(false)
const route = useRoute()
const positionId = ref(Number(route.query.position_id) || 0)

function applyPositionContext(id: number): void {
  positionId.value = Math.max(id, 0)
  contextReady.value = id >= 0
}

const items = ref<MediaRow[]>([])
const positions = ref<ServicePosition[]>([])
const loading = ref(false)
const uploading = ref(false)
const keyword = ref('')
const kindFilter = ref('')
const bindFilter = ref('')
const page = ref(1)
const pageSize = ref(20)
const fileInput = ref<HTMLInputElement | null>(null)
const previewVisible = ref(false)
const previewItem = ref<MediaRow | null>(null)
const previewUrl = ref('')
const previewError = ref('')
let previewRequest: AbortController | undefined
let disposed = false

// 素材请求通过 http 带鉴权，再交给浏览器渲染 Blob。
async function fetchMedia(row: MediaRow, signal?: AbortSignal): Promise<Blob> {
  const { data } = await http.get<Blob>(`/api/v1/agent/media/${encodeURIComponent(row.name)}`, {
    responseType: 'blob',
    signal,
  })
  return data
}

const thumbUrls = ref<Record<number, string>>({})
const thumbLoading = ref<Record<number, boolean>>({})

async function loadThumb(row: MediaRow): Promise<void> {
  if (thumbUrls.value[row.id] || thumbLoading.value[row.id]) return
  thumbLoading.value[row.id] = true
  try {
    const data = await fetchMedia(row)
    if (disposed) return
    thumbUrls.value = { ...thumbUrls.value, [row.id]: URL.createObjectURL(data) }
  } catch {
    /* 拉不到就保持占位图标 */
  } finally {
    thumbLoading.value[row.id] = false
  }
}

function revokeThumbs(): void {
  for (const url of Object.values(thumbUrls.value)) URL.revokeObjectURL(url)
  thumbUrls.value = {}
}

onBeforeUnmount(() => {
  disposed = true
  clearPreview()
  revokeThumbs()
})

const imageCount = computed(() => items.value.filter((i) => i.kind === 'image').length)
const videoCount = computed(() => items.value.filter((i) => i.kind === 'video').length)
const generalCount = computed(() => items.value.filter((i) => !i.position_id).length)

const filtered = computed(() => {
  const key = keyword.value.trim()
  return items.value.filter((item) => {
    if (positionId.value && item.position_id !== 0 && item.position_id !== positionId.value) return false
    if (kindFilter.value && item.kind !== kindFilter.value) return false
    if (bindFilter.value === 'general' && item.position_id) return false
    if (bindFilter.value === 'position' && !item.position_id) return false
    if (key && !item.name.includes(key)) return false
    return true
  })
})

const paged = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})


// 筛选变化时回到第 1 页，避免停在空页
watch([[keyword], [kindFilter], [bindFilter]], () => {
  page.value = 1
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const { data } = await http.get<PageResult<MediaRow>>('/api/v1/media', {
      params: { page: 1, page_size: 500 },
    })
    items.value = data.items || []
    loading.value = false
    // 列表只下载图片缩略图，视频等打开预览时再加载。
    const images = items.value.filter(row => row.kind === 'image')
    const batch = 4
    for (let index = 0; index < images.length && !disposed; index += batch) {
      images.slice(index, index + batch).forEach(row => void loadThumb(row))
      await new Promise(resolve => setTimeout(resolve, 120))
    }
    return
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '素材列表加载失败')
  } finally {
    loading.value = false
  }
}

async function loadPositions(): Promise<void> {
  try {
    const { data } = await positionsApi.list({ page: 1, page_size: 500 })
    positions.value = data.items || []
  } catch {
    positions.value = []
  }
}

function pickFile(): void {
  fileInput.value?.click()
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

async function onFileChange(event: Event): Promise<void> {
  if (!contextReady.value) return
  const targetPositionId = positionId.value
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 20 * 1024 * 1024) {
    ElMessage.error('单个素材不能超过 20MB')
    return
  }
  const kind = file.type.startsWith('video') ? 'video' : 'image'
  uploading.value = true
  try {
    const data_base64 = await readAsBase64(file)
    await http.post('/api/v1/media', { name: file.name, kind, position_id: targetPositionId, data_base64 })
    ElMessage.success('素材已上传')
    await load()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '上传失败')
  } finally {
    uploading.value = false
  }
}

async function changeBinding(row: MediaRow, positionId: number): Promise<void> {
  const previous = row.position_id
  row.position_id = positionId
  try {
    await mediaApi.bind(row.id, { position_id: positionId })
    row.position_name = positions.value.find((p) => p.id === positionId)?.position_name || null
    ElMessage.success(positionId ? '已绑定岗位，即时生效' : '已设为通用素材')
  } catch (error: any) {
    row.position_id = previous
    ElMessage.error(error?.response?.data?.detail || '绑定保存失败')
  }
}

async function remove(row: MediaRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除素材「${row.name}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await mediaApi.remove(row.id)
    ElMessage.success('素材已删除')
    await load()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '删除失败')
  }
}

function clearPreview(): void {
  previewRequest?.abort()
  previewRequest = undefined
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  previewItem.value = null
  previewError.value = ''
}

async function preview(row: MediaRow): Promise<void> {
  clearPreview()
  previewItem.value = row
  previewVisible.value = true
  const request = new AbortController()
  previewRequest = request
  try {
    const data = await fetchMedia(row, request.signal)
    if (!request.signal.aborted) previewUrl.value = URL.createObjectURL(data)
  } catch {
    if (!request.signal.aborted) previewError.value = '素材加载失败，请关闭后重新预览。'
  }
}

onMounted(async () => {
  await Promise.all([load(), loadPositions()])
})
</script>

<style scoped>
.hidden-input {
  display: none;
}

.media-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.media-thumb {
  width: 56px;
  height: 42px;
  border-radius: 8px;
  background: #f2f4f8;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--bd-text-tertiary);
  flex: none;
}

.media-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.media-name {
  font-size: 13px;
  color: var(--bd-text-primary);
}

.media-sub {
  margin-top: 2px;
  font-size: 11px;
  color: var(--bd-text-tertiary);
}

.binding-select {
  width: 100%;
}

.preview-body {
  display: flex;
  justify-content: center;
  max-height: 65vh;
  overflow: auto;
}

.preview-body img,
.preview-body video {
  max-width: 100%;
  max-height: 65vh;
  object-fit: contain;
  border-radius: 8px;
}
</style>
