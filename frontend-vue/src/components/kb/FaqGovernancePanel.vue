<template>
  <div class="kb-faq-panel">
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ audit?.total ?? faqs.length }}</div>
        <div class="stat-label">问答总数</div>
      </div>
      <div class="stat-card stat-active">
        <div class="stat-value">{{ enabledCount }}</div>
        <div class="stat-label">启用中</div>
      </div>
      <div class="stat-card stat-inactive">
        <div class="stat-value">{{ audit?.needs_review ?? issueCount }}</div>
        <div class="stat-label">待治理</div>
      </div>
    </div>

    <el-alert
      v-if="error"
      type="error"
      :closable="false"
      show-icon
      title="FAQ 数据加载失败"
    >
      <template #default>
        <div class="kb-inline-error">
          <span>{{ error }}</span>
          <el-button size="small" @click="load">重试</el-button>
        </div>
      </template>
    </el-alert>

    <div class="filter-bar">
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索问题或答案..."
        clearable
        :prefix-icon="Search"
      />
      <el-select v-model="verticalFilter" class="status-select" placeholder="分类筛选" clearable>
        <el-option label="全部分类" value="" />
        <el-option v-for="vertical in verticals" :key="vertical.id" :label="vertical.name" :value="String(vertical.id)" />
      </el-select>
      <el-select v-model="statusFilter" class="status-select" placeholder="状态筛选" clearable>
        <el-option label="全部状态" value="" />
        <el-option label="启用" value="enabled" />
        <el-option label="停用" value="disabled" />
      </el-select>
      <el-checkbox v-model="onlyIssues" label="只看待治理" />
      <div class="kb-filter-actions">
        <el-button type="primary" :icon="Plus" @click="openCreate">新增 FAQ</el-button>
      </div>
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="pagedFaqs" row-key="id">
        <el-table-column prop="question" label="问题" min-width="260">
          <template #default="{ row }">
            <div class="kb-question">{{ row.question }}</div>
            <div class="kb-answer muted">{{ row.answer }}</div>
          </template>
        </el-table-column>
        <el-table-column label="分类" width="110">
          <template #default="{ row }">
            <span>{{ verticalName(row.vertical_id) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="关键词" min-width="180">
          <template #default="{ row }">
            <div v-if="row.keywords.length" class="kb-keywords">
              <el-tag v-for="tag in row.keywords.slice(0, 4)" :key="tag" size="small" effect="plain">{{ tag }}</el-tag>
              <span v-if="row.keywords.length > 4" class="muted">+{{ row.keywords.length - 4 }}</span>
            </div>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'enabled' ? 'success' : 'info'" effect="light">
              {{ row.status === 'enabled' ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="治理" width="150">
          <template #default="{ row }">
            <el-tooltip v-if="issueOf(row.id).length" placement="top">
              <template #content>
                <div v-for="issue in issueOf(row.id)" :key="issue.code + issue.detail">
                  {{ issue.detail }}
                </div>
              </template>
              <el-tag type="warning" effect="light" size="small">
                {{ issueOf(row.id).length }} 项待处理
              </el-tag>
            </el-tooltip>
            <el-tag v-else type="success" effect="plain" size="small">正常</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">
            <span class="muted">{{ formatDateTime(row.updated_at) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button
              link
              :type="row.status === 'enabled' ? 'warning' : 'success'"
              @click="toggleStatus(row)"
            >
              {{ row.status === 'enabled' ? '停用' : '启用' }}
            </el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无 FAQ 数据" />
        </template>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="filteredFaqs.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </div>

    <KnowledgeFormDialog
      v-model="dialogVisible"
      :item="editing"
      :positions="positions"
      :positions-loading="positionsLoading"
      :verticals="verticals"
      :locations="locations"
      :employers="employers"
      :submitting="submitting"
      @submit="save"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Search } from '@element-plus/icons-vue'
import {
  auditKbFaqs,
  createKbFaq,
  knowledgeErrorMessage,
  listKbFaqs,
  removeKbFaq,
  setKbFaqStatus,
  updateKbFaq,
  type Employer,
  type KbFaqAuditIssue,
  type KbFaqAuditResult,
  type KnowledgeDraft,
  type KnowledgeItem,
  type LocationNode,
  type Vertical,
} from '../../api/knowledge'
import { formatDateTime } from '../../utils/format'
import type { ServicePosition } from '../../api/types'
import KnowledgeFormDialog from './KnowledgeFormDialog.vue'

const props = defineProps<{
  verticals: Vertical[]
  locations: LocationNode[]
  employers: Employer[]
  positions: ServicePosition[]
  positionsLoading: boolean
}>()

const loading = ref(false)
const error = ref('')
const faqs = ref<KnowledgeItem[]>([])
const audit = ref<KbFaqAuditResult | null>(null)
const keyword = ref('')
const verticalFilter = ref('')
const statusFilter = ref('')
const onlyIssues = ref(false)
const page = ref(1)
const pageSize = ref(20)

const dialogVisible = ref(false)
const submitting = ref(false)
const editing = ref<KnowledgeItem | null>(null)

const issueMap = computed(() => {
  const map = new Map<number, KbFaqAuditIssue[]>()
  for (const item of audit.value?.items ?? []) map.set(item.id, item.governance)
  return map
})

const issueCount = computed(() => [...issueMap.value.values()].filter((items) => items.length).length)
const enabledCount = computed(() => faqs.value.filter((item) => item.status === 'enabled').length)

const filteredFaqs = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return faqs.value.filter((item) => {
    if (statusFilter.value && item.status !== statusFilter.value) return false
    if (verticalFilter.value && String(item.vertical_id ?? '') !== verticalFilter.value) return false
    if (onlyIssues.value && !issueOf(item.id).length) return false
    if (key && !item.question.toLowerCase().includes(key) && !item.answer.toLowerCase().includes(key)) return false
    return true
  })
})

const pagedFaqs = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredFaqs.value.slice(start, start + pageSize.value)
})

function issueOf(id: number): KbFaqAuditIssue[] {
  return issueMap.value.get(id) ?? []
}

function verticalName(id: number | null): string {
  if (!id) return '通用'
  return props.verticals.find((item) => item.id === id)?.name ?? `#${id}`
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [list, auditResult] = await Promise.all([listKbFaqs(), auditKbFaqs()])
    faqs.value = list.items
    audit.value = auditResult
    if (page.value > 1 && pagedFaqs.value.length === 0) page.value = 1
  } catch (err) {
    error.value = knowledgeErrorMessage(err, 'FAQ 数据加载失败')
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  editing.value = null
  dialogVisible.value = true
}

function openEdit(row: KnowledgeItem): void {
  editing.value = row
  dialogVisible.value = true
}

async function save(draft: KnowledgeDraft): Promise<void> {
  submitting.value = true
  try {
    if (editing.value) {
      await updateKbFaq(editing.value.id, draft)
      ElMessage.success('FAQ 已更新')
    } else {
      await createKbFaq(draft)
      ElMessage.success('FAQ 已新增')
    }
    dialogVisible.value = false
    await load()
  } catch (err) {
    ElMessage.error(knowledgeErrorMessage(err, '保存失败'))
  } finally {
    submitting.value = false
  }
}

async function toggleStatus(row: KnowledgeItem): Promise<void> {
  const enabled = row.status !== 'enabled'
  try {
    await setKbFaqStatus(row.id, enabled)
    ElMessage.success(enabled ? '已启用' : '已停用')
    await load()
  } catch (err) {
    ElMessage.error(knowledgeErrorMessage(err, '状态更新失败'))
  }
}

async function remove(row: KnowledgeItem): Promise<void> {
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
    await removeKbFaq(row.id)
    ElMessage.success('已删除')
    await load()
  } catch (err) {
    ElMessage.error(knowledgeErrorMessage(err, '删除失败'))
  }
}

onMounted(load)

defineExpose({ reload: load })
</script>

<style scoped>
.kb-faq-panel {
  padding-top: 4px;
}

.kb-question {
  font-weight: 600;
  color: var(--bd-text-primary);
}

.kb-answer {
  margin-top: 4px;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 520px;
}

.kb-keywords {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.kb-filter-actions {
  margin-left: auto;
}

.kb-inline-error {
  display: flex;
  align-items: center;
  gap: 12px;
}

.search-input {
  width: 260px;
}

.status-select {
  width: 140px;
}
</style>
