<template>
  <el-drawer
    :model-value="modelValue"
    title="发布历史"
    size="560px"
    @update:model-value="close"
  >
    <div v-loading="loading" class="kb-history">
      <el-alert
        v-if="error"
        type="error"
        :closable="false"
        show-icon
        title="历史加载失败"
      >
        <template #default>
          <div class="kb-history-error">
            <p>{{ error }}</p>
            <el-button size="small" @click="load">重试</el-button>
          </div>
        </template>
      </el-alert>

      <template v-else>
        <div v-if="targetUrl" class="kb-history-meta">
          <span class="muted">目标服务</span>
          <code>{{ targetUrl }}</code>
        </div>

        <el-empty v-if="!loading && !rows.length" description="暂无发布记录" :image-size="90" />

        <el-timeline v-else>
          <el-timeline-item
            v-for="(row, index) in rows"
            :key="row.key"
            :timestamp="row.createdAt || `记录 ${index + 1}`"
            :type="row.status === 'failed' ? 'danger' : row.status === 'success' ? 'success' : 'primary'"
          >
            <div class="kb-history-row">
              <div class="kb-history-title">
                <strong>{{ row.title }}</strong>
                <el-tag v-if="row.status" size="small" :type="row.status === 'failed' ? 'danger' : 'success'" effect="light">
                  {{ row.status }}
                </el-tag>
              </div>
              <p v-if="row.detail" class="kb-history-detail">{{ row.detail }}</p>
              <p v-if="row.actor" class="muted">操作人：{{ row.actor }}</p>
            </div>
          </el-timeline-item>
        </el-timeline>
      </template>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { knowledgeErrorMessage, listKbPublishHistory } from '../../api/knowledge'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

const loading = ref(false)
const error = ref('')
const history = ref<Record<string, unknown>>({})

interface HistoryRow {
  key: string
  title: string
  status: string
  detail: string
  actor: string
  createdAt: string
}

const targetUrl = computed(() => {
  const value = history.value.target_url ?? history.value.targetUrl
  return typeof value === 'string' ? value : ''
})

const rows = computed<HistoryRow[]>(() => {
  const raw = history.value.items ?? history.value.history ?? history.value.publications ?? history.value.records
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 100).map((item, index) => {
    const row = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const id = row.publication_id ?? row.id ?? row.preview_id ?? index + 1
    const changes = Array.isArray(row.changes) ? row.changes.length : row.change_count
    return {
      key: String(id),
      title: String(row.status ?? row.result ?? '发布记录'),
      status: String(row.status ?? ''),
      detail:
        typeof row.detail === 'string'
          ? row.detail
          : changes !== undefined
            ? `差异 ${changes} 条`
            : '',
      actor: String(row.actor ?? row.username ?? ''),
      createdAt: String(row.created_at ?? row.applied_at ?? row.finished_at ?? ''),
    }
  })
})

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    history.value = await listKbPublishHistory()
  } catch (err) {
    error.value = knowledgeErrorMessage(err, '发布历史加载失败，请检查回复服务配置')
  } finally {
    loading.value = false
  }
}

function close(value = false): void {
  emit('update:modelValue', value)
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) void load()
    else {
      history.value = {}
      error.value = ''
    }
  },
)
</script>

<style scoped>
.kb-history {
  min-height: 160px;
}

.kb-history-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 16px;
  font-size: 12px;
}

.kb-history-meta code {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bd-bg-page, #f5f7fb);
}

.kb-history-row {
  padding-bottom: 4px;
}

.kb-history-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.kb-history-detail {
  margin: 4px 0;
  font-size: 13px;
  color: var(--bd-text-secondary, #4b5563);
}

.kb-history-error {
  display: flex;
  align-items: center;
  gap: 12px;
}

.kb-history-error p {
  margin: 0;
}
</style>
