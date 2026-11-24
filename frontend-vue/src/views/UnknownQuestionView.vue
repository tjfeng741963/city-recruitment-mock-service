<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">未知问题管理</h2>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ pendingCount }}</div>
        <div class="stat-label">待处理</div>
      </div>
      <div class="stat-card stat-active">
        <div class="stat-value">{{ resolvedCount }}</div>
        <div class="stat-label">已处理</div>
      </div>
      <div class="stat-card stat-inactive">
        <div class="stat-value">{{ ignoredCount }}</div>
        <div class="stat-label">已忽略</div>
      </div>
    </div>

    <el-alert
      v-if="error"
      type="error"
      :closable="false"
      show-icon
      title="未知问题加载失败"
    >
      <template #default>
        <div class="kb-inline-error">
          <span>{{ error }}</span>
          <el-button size="small" @click="load">重试</el-button>
        </div>
      </template>
    </el-alert>

    <div class="filter-bar">
      <el-radio-group v-model="statusFilter" class="kb-status-tabs">
        <el-radio-button label="all">全部 {{ items.length }}</el-radio-button>
        <el-radio-button label="pending">待处理 {{ pendingCount }}</el-radio-button>
        <el-radio-button label="resolved">已处理 {{ resolvedCount }}</el-radio-button>
        <el-radio-button label="ignored">已忽略 {{ ignoredCount }}</el-radio-button>
      </el-radio-group>
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索问题..."
        clearable
        :prefix-icon="Search"
      />
    </div>

    <div v-if="selectedIds.length || batchBusy" class="kb-batch-bar">
      <span class="kb-batch-count">已选 {{ selectedIds.length }} 项</span>
      <el-button
        size="small"
        type="danger"
        plain
        :disabled="batchBusy || !selectedIds.length"
        @click="batchDelete"
      >
        批量删除
      </el-button>
      <el-button size="small" link @click="clearSelection">取消选择</el-button>
      <div v-if="batchBusy" class="kb-batch-progress">
        <el-progress :percentage="batchPercent" :stroke-width="6" />
        <span class="muted">{{ batchDone }}/{{ batchTotal }}</span>
      </div>
    </div>

    <div class="table-wrapper">
      <el-table
        ref="tableRef"
        v-loading="loading"
        :data="pagedItems"
        row-key="id"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="46" />
        <el-table-column label="问题" min-width="320">
          <template #default="{ row }">
            <div class="kb-question">{{ row.question }}</div>
            <div v-if="row.merged_questions.length" class="kb-merged muted">
              相似问法：{{ row.merged_questions.join('、') }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="次数" width="90">
          <template #default="{ row }">
            <span class="kb-count">{{ row.count }}</span>
          </template>
        </el-table-column>
        <el-table-column label="城市" width="120">
          <template #default="{ row }">
            <span>{{ row.city_name || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusMeta(row.status).type" effect="light">
              {{ statusMeta(row.status).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近出现" width="170">
          <template #default="{ row }">
            <span class="muted">{{ formatDateTime(row.last_seen_at) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              :disabled="row.status === 'resolved'"
              @click="openConvert(row)"
            >
              转为知识库
            </el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无未知问题" />
        </template>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="filteredItems.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </div>

    <el-dialog
      v-model="convertVisible"
      title="转为知识库"
      width="660px"
      destroy-on-close
    >
      <el-form label-width="88px" @submit.prevent>
        <el-form-item label="问题">
          <el-input v-model="convertForm.question" disabled />
        </el-form-item>
        <el-form-item label="答案" required>
          <el-input
            v-model="convertForm.answer"
            type="textarea"
            :rows="5"
            maxlength="2000"
            show-word-limit
            placeholder="填写对外回复内容"
          />
        </el-form-item>
        <el-form-item label="关键词">
          <div class="kb-tag-input">
            <el-tag
              v-for="tag in convertForm.keywords"
              :key="tag"
              closable
              effect="plain"
              @close="removeConvertKeyword(tag)"
            >
              {{ tag }}
            </el-tag>
            <el-input
              v-model="convertKeywordInput"
              class="kb-tag-field"
              placeholder="输入后按回车或逗号添加"
              @keydown.enter.prevent="addConvertKeyword"
              @blur="addConvertKeyword"
            />
          </div>
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="convertForm.vertical_id" clearable placeholder="全部分类" class="w-full">
            <el-option
              v-for="vertical in verticals"
              :key="vertical.id"
              :label="vertical.name"
              :value="vertical.id"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="convertVisible = false">取消</el-button>
          <el-button type="primary" :loading="converting" @click="submitConvert">转为知识库</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Search } from '@element-plus/icons-vue'
import {
  convertUnknownQuestion,
  knowledgeErrorMessage,
  listUnknownQuestions,
  listVerticals,
  removeUnknownQuestion,
  type UnknownQuestionItem,
  type Vertical,
} from '../api/knowledge'
import { formatDateTime } from '../utils/format'

const items = ref<UnknownQuestionItem[]>([])
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const statusFilter = ref('all')
const page = ref(1)
const pageSize = ref(20)

const tableRef = ref()
const selectedIds = ref<number[]>([])
const batchBusy = ref(false)
const batchDone = ref(0)
const batchTotal = ref(0)

const verticals = ref<Vertical[]>([])
const convertVisible = ref(false)
const converting = ref(false)
const convertRow = ref<UnknownQuestionItem | null>(null)
const convertKeywordInput = ref('')
const convertForm = ref({
  question: '',
  answer: '',
  keywords: [] as string[],
  vertical_id: null as number | null,
})

const pendingCount = computed(() => items.value.filter((item) => item.status === 'pending').length)
const resolvedCount = computed(() => items.value.filter((item) => item.status === 'resolved').length)
const ignoredCount = computed(() => items.value.filter((item) => item.status === 'ignored').length)
const batchPercent = computed(() =>
  batchTotal.value ? Math.round((batchDone.value / batchTotal.value) * 100) : 0,
)

const filteredItems = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return items.value.filter((item) => {
    if (statusFilter.value !== 'all' && item.status !== statusFilter.value) return false
    if (key) {
      const haystack = [item.question, item.city_name, ...item.merged_questions].join(' ').toLowerCase()
      if (!haystack.includes(key)) return false
    }
    return true
  })
})

const pagedItems = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredItems.value.slice(start, start + pageSize.value)
})

function statusMeta(status: string): { label: string; type: 'success' | 'warning' | 'info' | 'danger' } {
  if (status === 'resolved') return { label: '已处理', type: 'success' }
  if (status === 'ignored') return { label: '已忽略', type: 'info' }
  if (status === 'pending') return { label: '待处理', type: 'warning' }
  return { label: status || '待处理', type: 'info' }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    items.value = await listUnknownQuestions()
    if (page.value > 1 && pagedItems.value.length === 0) page.value = 1
    clearSelection()
  } catch (err) {
    items.value = []
    error.value = knowledgeErrorMessage(err, '未知问题加载失败')
  } finally {
    loading.value = false
  }
}

async function loadOptions(): Promise<void> {
  try {
    verticals.value = await listVerticals()
  } catch {
    verticals.value = []
  }
}

function clearSelection(): void {
  selectedIds.value = []
  tableRef.value?.clearSelection?.()
}

function onSelectionChange(rows: UnknownQuestionItem[]): void {
  selectedIds.value = rows.map((row) => row.id)
}

function openConvert(row: UnknownQuestionItem): void {
  convertRow.value = row
  convertForm.value = {
    question: row.question,
    answer: '',
    keywords: [...row.merged_questions],
    vertical_id: null,
  }
  convertKeywordInput.value = ''
  convertVisible.value = true
}

function addConvertKeyword(): void {
  const value = convertKeywordInput.value.trim().replace(/^[,，]+|[,，]+$/g, '')
  if (!value) {
    convertKeywordInput.value = ''
    return
  }
  for (const part of value.split(/[,，]/).map((item) => item.trim()).filter(Boolean)) {
    if (!convertForm.value.keywords.includes(part)) convertForm.value.keywords.push(part)
  }
  convertKeywordInput.value = ''
}

function removeConvertKeyword(tag: string): void {
  convertForm.value.keywords = convertForm.value.keywords.filter((item) => item !== tag)
}

async function submitConvert(): Promise<void> {
  if (!convertRow.value) return
  addConvertKeyword()
  if (!convertForm.value.answer.trim()) {
    ElMessage.warning('请填写答案')
    return
  }
  converting.value = true
  try {
    await convertUnknownQuestion(convertRow.value.id, {
      answer: convertForm.value.answer.trim(),
      title: convertForm.value.question,
      keywords: convertForm.value.keywords,
      vertical_id: convertForm.value.vertical_id,
    })
    ElMessage.success('已转为知识库')
    convertVisible.value = false
    await load()
  } catch (err) {
    ElMessage.error(knowledgeErrorMessage(err, '转换失败'))
  } finally {
    converting.value = false
  }
}

async function remove(row: UnknownQuestionItem): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除「${row.question}」吗？删除后不可恢复。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await removeUnknownQuestion(row.id)
    ElMessage.success('已删除')
    await load()
  } catch (err) {
    ElMessage.error(knowledgeErrorMessage(err, '删除失败'))
  }
}

async function batchDelete(): Promise<void> {
  const ids = [...selectedIds.value]
  if (!ids.length) return
  try {
    await ElMessageBox.confirm(
      `后端没有批量删除接口，将逐条删除 ${ids.length} 项，删除后不可恢复。是否继续？`,
      '批量删除',
      { type: 'warning', confirmButtonText: '开始删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  batchBusy.value = true
  batchDone.value = 0
  batchTotal.value = ids.length
  let failed = 0
  const errors: string[] = []
  try {
    for (const id of ids) {
      try {
        await removeUnknownQuestion(id)
      } catch (err) {
        failed += 1
        errors.push(knowledgeErrorMessage(err, '删除失败'))
      }
      batchDone.value += 1
    }
    if (failed) {
      ElMessage.warning(`删除完成，成功 ${ids.length - failed} 条，失败 ${failed} 条`)
      if (errors.length) {
        await ElMessageBox.alert(errors.slice(0, 5).join('；'), '部分删除失败', {
          type: 'warning',
          confirmButtonText: '知道了',
        }).catch(() => undefined)
      }
    } else {
      ElMessage.success(`已删除 ${ids.length} 条`)
    }
    await load()
  } finally {
    batchBusy.value = false
    batchDone.value = 0
    batchTotal.value = 0
  }
}

watch([keyword, statusFilter], () => {
  page.value = 1
})

onMounted(() => {
  void loadOptions()
  void load()
})
</script>

<style scoped>
.kb-question {
  font-weight: 600;
  color: var(--bd-text-primary);
}

.kb-merged {
  margin-top: 4px;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 640px;
}

.kb-count {
  display: inline-block;
  min-width: 30px;
  padding: 2px 8px;
  border-radius: 999px;
  background: #f2f3f7;
  text-align: center;
  font-weight: 600;
  color: var(--bd-text-primary);
}

.kb-inline-error {
  display: flex;
  align-items: center;
  gap: 12px;
}

.kb-batch-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bd-border, #e5e7eb);
  border-radius: 10px;
  background: #fff;
}

.kb-batch-count {
  font-size: 13px;
  font-weight: 600;
  color: var(--bd-text-primary);
}

.kb-batch-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 220px;
  flex: 1;
}

.kb-batch-progress :deep(.el-progress) {
  flex: 1;
}

.kb-tag-input {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 32px;
  padding: 3px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
}

.kb-tag-input:focus-within {
  border-color: var(--el-color-primary);
}

.kb-tag-field {
  flex: 1;
  min-width: 140px;
}

.kb-tag-field :deep(.el-input__wrapper) {
  box-shadow: none;
  padding: 0;
}

.w-full {
  width: 100%;
}

.kb-status-tabs {
  margin-right: 4px;
}

.search-input {
  width: 260px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
