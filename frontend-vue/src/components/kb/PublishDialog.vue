<template>
  <el-dialog
    :model-value="modelValue"
    title="发布知识库"
    width="760px"
    destroy-on-close
    @update:model-value="close"
  >
    <div v-if="loading" class="kb-publish-loading">
      <el-skeleton :rows="5" animated />
      <p class="muted">正在读取发布差异…</p>
    </div>

    <el-alert
      v-else-if="error"
      type="error"
      :closable="false"
      show-icon
      title="预览失败"
      :description="error"
    />

    <div v-if="!loading && errorIssues.length" class="kb-issue-list">
      <p class="kb-section-title">需要先处理的问题（{{ errorIssues.length }}）</p>
      <ul>
        <li v-for="(issue, index) in errorIssues.slice(0, 20)" :key="index">
          {{ issueText(issue) }}
        </li>
      </ul>
    </div>

    <template v-else-if="preview">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="仅发布共享场景问答"
        :description="preview.note || '差异确认后才会写入回复服务。'"
      />

      <div class="stats-row kb-publish-stats">
        <div class="stat-card">
          <div class="stat-value">{{ preview.changes?.length ?? 0 }}</div>
          <div class="stat-label">差异条目</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ preview.target_generation ?? '-' }}</div>
          <div class="stat-label">目标版本</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ preview.issues?.length ?? 0 }}</div>
          <div class="stat-label">待处理问题</div>
        </div>
      </div>

      <div v-if="changeGroups.length" class="kb-change-summary">
        <el-tag v-for="group in changeGroups" :key="group.kind" type="info" effect="plain">
          {{ group.kind }} {{ group.count }}
        </el-tag>
      </div>

      <div v-if="preview.issues?.length" class="kb-issue-list">
        <p class="kb-section-title">发布检查未通过项</p>
        <ul>
          <li v-for="(issue, index) in preview.issues" :key="index">
            {{ issueText(issue) }}
          </li>
        </ul>
      </div>

      <el-table v-if="changeRows.length" :data="changeRows" max-height="280" size="small">
        <el-table-column label="类型" width="120">
          <template #default="{ row }">{{ row.kind }}</template>
        </el-table-column>
        <el-table-column label="问题 / 编号" min-width="220">
          <template #default="{ row }">{{ row.title }}</template>
        </el-table-column>
        <el-table-column label="说明" min-width="240">
          <template #default="{ row }">{{ row.detail }}</template>
        </el-table-column>
      </el-table>

      <el-empty v-else-if="!preview.changes?.length" description="没有需要发布的差异" :image-size="80" />
    </template>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="close(false)">取消</el-button>
        <el-button :disabled="loading" @click="loadPreview">重新预览</el-button>
        <el-button
          type="primary"
          :loading="applying"
          :disabled="loading || !!error || !preview"
          @click="confirmApply"
        >
          确认发布
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  applyKbPublish,
  knowledgeErrorMessage,
  previewKbPublish,
  type KbPublishPreview,
} from '../../api/knowledge'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'applied'): void
}>()

const loading = ref(false)
const applying = ref(false)
const error = ref('')
const errorIssues = ref<Array<Record<string, unknown>>>([])
const preview = ref<KbPublishPreview | null>(null)

interface ChangeRow {
  kind: string
  title: string
  detail: string
}

function issueText(issue: Record<string, unknown>): string {
  const code = String(issue.code ?? '')
  const detail = String(issue.detail ?? issue.message ?? '')
  const id = issue.id ?? issue.source_id
  return [id ? `#${id}` : '', code, detail].filter(Boolean).join(' · ') || JSON.stringify(issue)
}

const changeRows = computed<ChangeRow[]>(() => {
  const changes = preview.value?.changes ?? []
  return changes.slice(0, 50).map((change) => {
    if (typeof change !== 'object' || change === null) {
      return { kind: '变更', title: String(change), detail: '' }
    }
    const record = change as Record<string, unknown>
    return {
      kind: String(record.action ?? record.change_type ?? record.type ?? '变更'),
      title: String(record.question ?? record.source_id ?? record.id ?? '-'),
      detail: String(record.detail ?? record.reason ?? record.message ?? ''),
    }
  })
})

const changeGroups = computed(() => {
  const map = new Map<string, number>()
  for (const row of changeRows.value) map.set(row.kind, (map.get(row.kind) ?? 0) + 1)
  return [...map.entries()].map(([kind, count]) => ({ kind, count }))
})

async function loadPreview(): Promise<void> {
  loading.value = true
  error.value = ''
  errorIssues.value = []
  preview.value = null
  try {
    preview.value = await previewKbPublish({})
  } catch (err) {
    error.value = knowledgeErrorMessage(err, '发布预览失败，请检查回复服务配置')
    const issues = (err as { response?: { data?: { issues?: unknown } } })?.response?.data?.issues
    errorIssues.value = Array.isArray(issues) ? (issues as Array<Record<string, unknown>>) : []
  } finally {
    loading.value = false
  }
}

async function confirmApply(): Promise<void> {
  if (!preview.value?.preview_id) return
  try {
    await ElMessageBox.confirm(
      `将向回复服务发布 ${preview.value.changes?.length ?? 0} 条差异，发布后立即对客户生效。是否继续？`,
      '确认发布',
      { type: 'warning', confirmButtonText: '确认发布', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  applying.value = true
  try {
    await applyKbPublish(preview.value.preview_id)
    ElMessage.success('发布成功')
    emit('applied')
    close(false)
  } catch (err) {
    ElMessage.error(knowledgeErrorMessage(err, '发布失败'))
  } finally {
    applying.value = false
  }
}

function close(value = false): void {
  emit('update:modelValue', value)
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) void loadPreview()
    else {
      preview.value = null
      error.value = ''
      errorIssues.value = []
    }
  },
)
</script>

<style scoped>
.kb-publish-loading {
  padding: 8px 0;
}

.kb-publish-stats {
  margin: 18px 0 12px;
}

.kb-change-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.kb-issue-list {
  margin-bottom: 14px;
  padding: 10px 14px;
  border-radius: 8px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  color: #9a3412;
  font-size: 12px;
}

.kb-issue-list ul {
  margin: 6px 0 0;
  padding-left: 18px;
}

.kb-section-title {
  margin: 0;
  font-weight: 600;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
