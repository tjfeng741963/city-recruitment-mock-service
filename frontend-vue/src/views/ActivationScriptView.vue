<template>
  <section class="activation-scripts">
    <div class="page-header">
      <div>
        <h2 class="page-title">复聊语料库</h2>
      </div>
      <div class="header-actions">
        <input
          ref="fileInput"
          type="file"
          accept=".xlsx,.xls,.csv"
          class="file-input"
          @change="onFileChange"
        />
        <el-button :loading="importing" @click="triggerImport">导入</el-button>
        <el-button :loading="exporting" @click="handleExport">导出</el-button>
        <el-button type="primary" @click="notSupported('新增语料')">新增语料</el-button>
      </div>
    </div>

    <div class="script-summary">
      <span>共 <b>{{ rows.length }}</b> 条</span>
      <el-divider direction="vertical" />
      <span>启用 <b class="enabled-count">{{ enabledCount }}</b> 条（参与随机抽取）</span>
      <template v-if="!loading && enabledCount === 0">
        <el-divider direction="vertical" />
        <el-tag type="danger" size="small" effect="light">启用语料为 0，发送将被拦截</el-tag>
      </template>
    </div>

    <div class="filter-bar script-filter">
      <el-input
        v-model="keyword"
        placeholder="搜索语料内容..."
        clearable
        :prefix-icon="Search"
        class="search-input"
      />
      <el-select v-model="category" placeholder="分类筛选" clearable class="category-select">
        <el-option v-for="item in categories" :key="item" :label="item" :value="item" />
      </el-select>
      <el-select v-model="activeFilter" placeholder="启用状态" clearable class="status-select">
        <el-option label="启用" value="true" />
        <el-option label="停用" value="false" />
      </el-select>
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="pagedRows" row-key="id" size="small" style="width: 100%">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column label="语料内容" min-width="320">
          <template #default="{ row }">
            <el-tooltip :content="row.content" placement="top" :show-after="300">
              <div class="content-cell" :class="{ inactive: !row.is_active }">{{ row.content }}</div>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="分类" min-width="130">
          <template #default="{ row }">
            <el-tag v-if="row.category" size="small" effect="plain">{{ row.category }}</el-tag>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="90">
          <template #default="{ row }">
            <el-switch :model-value="Boolean(row.is_active)" title="A 类激活从启用语料中抽取话术，客户回复后仍由原 Dify 对话接待" @change="notSupported('切换启用状态')" />
          </template>
        </el-table-column>
        <el-table-column label="使用次数" min-width="100">
          <template #default="{ row }">
            <span class="used-count">{{ row.used_count ?? 0 }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最近使用" min-width="170">
          <template #default="{ row }">
            <span class="muted">{{ formatDateTime(row.last_used_at) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default>
            <el-button link type="primary" @click="notSupported('编辑语料')">编辑</el-button>
            <el-button link type="danger" @click="notSupported('删除语料')">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无数据" :image-size="70" />
        </template>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[20, 50, 100]"
          :total="filteredRows.length"
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="page = 1"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { activationApi, isApiMissing, type ActivationScript } from '../api/metrics'
import { downloadBlob, formatDateTime } from '../utils/format'

const rows = ref<ActivationScript[]>([])
const loading = ref(false)
const importing = ref(false)
const exporting = ref(false)
const keyword = ref('')
const category = ref('')
const activeFilter = ref<'' | 'true' | 'false'>('')
const page = ref(1)
const pageSize = ref(20)
const fileInput = ref<HTMLInputElement | null>(null)

const categories = computed(() => {
  const values = rows.value.map((row) => row.category).filter((item): item is string => Boolean(item))
  return Array.from(new Set(values))
})

const enabledCount = computed(() => rows.value.filter((row) => Boolean(row.is_active)).length)

const filteredRows = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return rows.value.filter((row) => {
    if (key && !String(row.content || '').toLowerCase().includes(key)) return false
    if (category.value && row.category !== category.value) return false
    if (activeFilter.value && String(Boolean(row.is_active)) !== activeFilter.value) return false
    return true
  })
})

const pagedRows = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredRows.value.slice(start, start + pageSize.value)
})

watch([keyword, category, activeFilter], () => {
  page.value = 1
})

function errorMessage(error: unknown): string {
  const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
  return detail || '操作失败'
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const { data } = await activationApi.scripts({ page: 1, page_size: 1000 })
    rows.value = Array.isArray(data) ? (data as unknown as ActivationScript[]) : data.items || []
  } catch (error) {
    if (isApiMissing(error)) {
      ElMessage.error('语料库接口未提供')
    } else {
      ElMessage.error(errorMessage(error))
    }
  } finally {
    loading.value = false
  }
}

function triggerImport(): void {
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  const form = new FormData()
  form.append('file', file)
  importing.value = true
  try {
    await activationApi.importScripts(form)
    ElMessage.success('语料导入成功')
    await load()
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    importing.value = false
    input.value = ''
  }
}

function resolveFilename(disposition?: string): string {
  if (disposition) {
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)
    if (encoded?.[1]) {
      try {
        return decodeURIComponent(encoded[1])
      } catch {
        // 继续尝试普通 filename
      }
    }
    const plain = disposition.match(/filename="?([^";]+)"?/i)
    if (plain?.[1]) return plain[1]
  }
  return 'activation-scripts.xlsx'
}

async function handleExport(): Promise<void> {
  exporting.value = true
  try {
    const response = await activationApi.exportScripts()
    const headers = response.headers as Record<string, string | undefined>
    downloadBlob(response.data, resolveFilename(headers['content-disposition']))
    ElMessage.success('语料文件已开始下载')
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    exporting.value = false
  }
}

function notSupported(action: string): void {
  ElMessage.warning(`后端未提供该接口：${action}`)
}

onMounted(() => {
  void load()
})
</script>

<style scoped>
.activation-scripts {
  width: 100%;
  min-width: 0;
}

.file-input {
  display: none;
}

.script-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-bottom: 12px;
  color: var(--bd-text-secondary);
  font-size: 13px;
}

.script-summary b {
  color: var(--bd-text-primary);
  font-weight: 600;
}

.enabled-count {
  color: #12a150;
}

.script-filter {
  flex-wrap: wrap;
  padding: 14px 16px;
}

.search-input {
  width: 240px;
  max-width: 100%;
}

.category-select {
  width: 160px;
  max-width: 100%;
}

.status-select {
  width: 130px;
  max-width: 100%;
}

.content-cell {
  display: -webkit-box;
  overflow: hidden;
  color: var(--bd-text-primary);
  font-size: 13px;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.content-cell.inactive {
  color: var(--bd-text-tertiary);
}

.used-count {
  color: var(--bd-text-primary);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 760px) {
  .search-input,
  .category-select,
  .status-select {
    width: 100%;
  }
}
</style>
