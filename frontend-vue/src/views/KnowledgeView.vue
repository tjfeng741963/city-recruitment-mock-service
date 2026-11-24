<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">问答知识库</h2>
        <p class="page-desc">编辑通用和岗位问答；启用且通过校验的问答会进入当前岗位 AI 回复，无需重复发布。</p>
      </div>
      <div class="header-actions">
        <el-button v-if="auth.user?.role === 'admin'" @click="router.push(receptionTestHref('dify', { positionId }))">到画布测试</el-button>
        <el-button :icon="Files" @click="templateVisible = true">模板包</el-button>
        <el-button v-if="false" :icon="Promotion" @click="publishVisible = true">发布</el-button>
        <el-button v-if="false" :icon="Clock" @click="historyVisible = true">发布历史</el-button>
        <el-button :icon="Upload" disabled title="旧导入不能完整保留岗位作用范围，完善前请使用新增问答">导入（待完善）</el-button>
        <el-button :icon="Download" :disabled="!items.length" @click="handleExport">导出</el-button>
        <el-button type="primary" :icon="Plus" :disabled="!contextReady" @click="openCreate">新增知识</el-button>
      </div>
    </div>

    <PositionContext @validated="applyPositionContext" />

    <el-alert v-if="activeTab !== 'library'" title="历史资料与治理工具；当前接待只读取通用和本岗位问答。这里的旧实体范围不代表已接入回复。" type="info" :closable="false" />
    <el-tabs v-model="activeTab" class="kb-tabs">
      <el-tab-pane label="知识库" name="library">
        <div class="stats-row">
          <div class="stat-card">
            <div class="stat-value">{{ scopedItems.length }}</div>
            <div class="stat-label">总条目</div>
          </div>
          <div class="stat-card stat-active">
            <div class="stat-value">{{ enabledCount }}</div>
            <div class="stat-label">启用中</div>
          </div>
          <div class="stat-card stat-inactive">
            <div class="stat-value">{{ disabledCount }}</div>
            <div class="stat-label">已停用</div>
          </div>
        </div>

        <el-alert
          v-if="error"
          type="error"
          :closable="false"
          show-icon
          title="知识库加载失败"
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
            placeholder="搜索问题、答案或关键词..."
            clearable
            :prefix-icon="Search"
          />
          <el-select v-model="verticalFilter" class="status-select" placeholder="分类筛选" clearable>
            <el-option label="全部分类" value="" />
            <el-option
              v-for="vertical in verticals"
              :key="vertical.id"
              :label="vertical.name"
              :value="String(vertical.id)"
            />
          </el-select>
          <el-select v-model="statusFilter" class="status-select" placeholder="状态筛选" clearable>
            <el-option label="全部状态" value="" />
            <el-option label="启用" value="enabled" />
            <el-option label="停用" value="disabled" />
          </el-select>
          <el-button :icon="Refresh" @click="load">刷新</el-button>
        </div>

        <div v-if="selectedIds.length || batchBusy" class="kb-batch-bar">
          <span class="kb-batch-count">已选 {{ selectedIds.length }} 项</span>
          <el-button
            size="small"
            type="success"
            plain
            :disabled="batchBusy || !selectedIds.length"
            @click="batchStatus(true)"
          >
            批量启用
          </el-button>
          <el-button
            size="small"
            type="warning"
            plain
            :disabled="batchBusy || !selectedIds.length"
            @click="batchStatus(false)"
          >
            批量停用
          </el-button>
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

        <div v-if="importing" class="kb-batch-bar">
          <span class="kb-batch-count">正在导入…</span>
          <div class="kb-batch-progress">
            <el-progress :percentage="importPercent" :stroke-width="6" />
            <span class="muted">{{ importDone }}/{{ importTotal }}</span>
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
            <el-table-column label="问题" min-width="280">
              <template #default="{ row }">
                <div class="kb-question">{{ row.question }}</div>
                <div class="kb-answer muted">{{ row.answer || '（暂无答案内容）' }}</div>
              </template>
            </el-table-column>
            <el-table-column label="适用范围" min-width="130">
              <template #default="{ row }">{{ row.scope_level === 'position' ? (Number(row.scope_position_id) === positionId ? positionName || '当前岗位' : '岗位专属') : row.scope_level === 'global' && !row.vertical_id ? '所有岗位通用' : '历史限定范围' }}</template>
            </el-table-column>
            <el-table-column label="分类" width="110">
              <template #default="{ row }">
                <span>{{ verticalName(row.vertical_id) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="关键词" min-width="200">
              <template #default="{ row }">
                <div v-if="row.keywords.length" class="kb-keywords">
                  <el-tag
                    v-for="tag in row.keywords.slice(0, 4)"
                    :key="tag"
                    size="small"
                    effect="plain"
                  >
                    {{ tag }}
                  </el-tag>
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
            <el-table-column label="排序" width="80">
              <template #default="{ row }">
                <span class="muted">{{ row.sort_order }}</span>
              </template>
            </el-table-column>
            <el-table-column label="更新时间" width="170">
              <template #default="{ row }">
                <span class="muted">{{ formatDateTime(row.updated_at) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="140" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
                <el-button link type="danger" @click="remove(row)">删除</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="暂无知识条目，点击右上角「新增知识」创建第一条" />
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
      </el-tab-pane>

      <el-tab-pane label="历史品类" name="vertical" lazy>
        <KbEntityPanel kind="vertical" />
      </el-tab-pane>
      <el-tab-pane label="历史区域" name="location" lazy>
        <KbEntityPanel kind="location" />
      </el-tab-pane>
      <el-tab-pane label="历史招工方" name="employer" lazy>
        <KbEntityPanel kind="employer" />
      </el-tab-pane>
      <el-tab-pane label="历史绑定" name="device" lazy>
        <KbDeviceBinding />
      </el-tab-pane>
      <el-tab-pane label="问答检查" name="faq" lazy>
        <FaqGovernancePanel
          ref="faqPanelRef"
          :verticals="verticals"
          :locations="locations"
          :employers="employers"
        />
      </el-tab-pane>
    </el-tabs>

    <KnowledgeFormDialog
      v-model="dialogVisible"
      :item="editing"
      :position-id="positionId"
      :position-name="positionName"
      :verticals="verticals"
      :locations="locations"
      :employers="employers"
      :submitting="submitting"
      @submit="save"
    />

    <PublishDialog v-model="publishVisible" @applied="load" />
    <HistoryDrawer v-model="historyVisible" />
    <TemplateDialog v-model="templateVisible" @imported="onTemplateImported" />

    <input
      ref="fileInput"
      type="file"
      accept=".csv,.json,text/csv,application/json"
      class="kb-file-input"
      @change="onImportFile"
    />
  </section>
</template>

<script setup lang="ts">
import { receptionTestHref } from '../components/agent/device-workflow-entry'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import PositionContext from '../components/agent/PositionContext.vue'
import { positionsApi } from '../api/core'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Clock, Download, Files, Plus, Promotion, Refresh, Search, Upload } from '@element-plus/icons-vue'
import {
  batchRemoveKnowledgeItems,
  batchSetKnowledgeStatus,
  createKnowledgeItem,
  exportKnowledge,
  getKnowledgeItem,
  importKnowledgeFile,
  knowledgeErrorMessage,
  listEmployers,
  listKnowledgeItems,
  listLocations,
  listVerticals,
  removeKnowledgeItem,
  updateKnowledgeItem,
  type Employer,
  type KnowledgeDraft,
  type KnowledgeItem,
  type KnowledgeSource,
  type LocationNode,
  type Vertical,
} from '../api/knowledge'
import { downloadBlob, formatDateTime } from '../utils/format'
import KnowledgeFormDialog from '../components/kb/KnowledgeFormDialog.vue'
import PublishDialog from '../components/kb/PublishDialog.vue'
import HistoryDrawer from '../components/kb/HistoryDrawer.vue'
import TemplateDialog from '../components/kb/TemplateDialog.vue'
import FaqGovernancePanel from '../components/kb/FaqGovernancePanel.vue'
import KbEntityPanel from '../components/kb/KbEntityPanel.vue'
import KbDeviceBinding from '../components/kb/KbDeviceBinding.vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const contextReady = ref(false)
const positionId = ref(Number(route.query.position_id) || 0)

function applyPositionContext(id: number): void {
  positionId.value = Math.max(id, 0)
  contextReady.value = id >= 0
}

const positionName = ref('')
const activeTab = ref('library')
const items = ref<KnowledgeItem[]>([])
const loading = ref(false)
const error = ref('')
const source = ref<KnowledgeSource>('knowledge')

const verticals = ref<Vertical[]>([])
const locations = ref<LocationNode[]>([])
const employers = ref<Employer[]>([])

const keyword = ref('')
const verticalFilter = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)

const tableRef = ref()
const selectedIds = ref<number[]>([])
const batchBusy = ref(false)
const batchDone = ref(0)
const batchTotal = ref(0)

const dialogVisible = ref(false)
const submitting = ref(false)
const editing = ref<KnowledgeItem | null>(null)

const publishVisible = ref(false)
const historyVisible = ref(false)
const templateVisible = ref(false)
const faqPanelRef = ref<InstanceType<typeof FaqGovernancePanel> | null>(null)

const fileInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)
const importDone = ref(0)
const importTotal = ref(0)

const scopedItems = computed(() => items.value.filter(item => !positionId.value ||
  item.scope_level === 'global' && !item.vertical_id || item.scope_level === 'position' && Number(item.scope_position_id) === positionId.value))
const enabledCount = computed(() => scopedItems.value.filter((item) => item.status === 'enabled').length)
const disabledCount = computed(() => scopedItems.value.length - enabledCount.value)
const batchPercent = computed(() =>
  batchTotal.value ? Math.round((batchDone.value / batchTotal.value) * 100) : 0,
)
const importPercent = computed(() =>
  importTotal.value ? Math.round((importDone.value / importTotal.value) * 100) : 0,
)

const filteredItems = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return items.value.filter((item) => {
    if (positionId.value && !(item.scope_level === 'global' && !item.vertical_id || item.scope_level === 'position' && Number(item.scope_position_id) === positionId.value)) return false
    if (statusFilter.value && item.status !== statusFilter.value) return false
    if (verticalFilter.value && String(item.vertical_id ?? '') !== verticalFilter.value) return false
    if (key) {
      const haystack = [item.question, item.answer, ...item.keywords].join(' ').toLowerCase()
      if (!haystack.includes(key)) return false
    }
    return true
  })
})

const pagedItems = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredItems.value.slice(start, start + pageSize.value)
})

function verticalName(id: number | null): string {
  if (!id) return '通用'
  return verticals.value.find((item) => item.id === id)?.name ?? `#${id}`
}

function categoryName(id: number | null): string {
  return verticalName(id)
}

async function loadOptions(): Promise<void> {
  try {
    const [verticalRows, locationRows, employerRows] = await Promise.all([
      listVerticals(),
      listLocations(),
      listEmployers(),
    ])
    verticals.value = verticalRows
    locations.value = locationRows
    employers.value = employerRows
  } catch {
    // 选项加载失败不阻塞列表；筛选/表单会退化为仅有“通用”选项。
  }
}

watch(positionId, async id => {
  page.value = 1
  positionName.value = ''
  if (id) {
    try { const {data} = await positionsApi.get(id); positionName.value = data.position_name } catch { /* selector displays failure */ }
  }
}, { immediate: true })

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await listKnowledgeItems()
    items.value = result.items
    source.value = result.source
    if (page.value > 1 && pagedItems.value.length === 0) page.value = 1
    clearSelection()
  } catch (err) {
    items.value = []
    error.value = knowledgeErrorMessage(err, '知识库加载失败')
  } finally {
    loading.value = false
  }
}

function clearSelection(): void {
  selectedIds.value = []
  tableRef.value?.clearSelection?.()
}

function onSelectionChange(rows: KnowledgeItem[]): void {
  selectedIds.value = rows.map((row) => row.id)
}

function openCreate(): void {
  editing.value = null
  dialogVisible.value = true
}

async function openEdit(row: KnowledgeItem): Promise<void> {
  editing.value = row
  dialogVisible.value = true
  if (row.source === 'knowledge' && !row.answer) {
    try {
      const full = await getKnowledgeItem(row.id, row.source)
      if (full) editing.value = { ...row, ...full }
    } catch {
      // 详情接口不可用时保留列表行，至少能改问题/状态
    }
  }
}

async function save(draft: KnowledgeDraft): Promise<void> {
  submitting.value = true
  try {
    if (editing.value) {
      await updateKnowledgeItem(editing.value.id, draft, editing.value.source)
      ElMessage.success('知识已更新')
    } else {
      await createKnowledgeItem(draft)
      ElMessage.success('知识已新增')
    }
    dialogVisible.value = false
    await load()
  } catch (err) {
    ElMessage.error(knowledgeErrorMessage(err, '保存失败'))
  } finally {
    submitting.value = false
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
    await removeKnowledgeItem(row.id, row.source)
    ElMessage.success('已删除')
    await load()
  } catch (err) {
    ElMessage.error(knowledgeErrorMessage(err, '删除失败'))
  }
}

async function runBatch(action: () => Promise<void>, successText: string): Promise<void> {
  batchBusy.value = true
  batchDone.value = 0
  batchTotal.value = selectedIds.value.length
  try {
    await action()
    ElMessage.success(successText)
    await load()
  } catch (err) {
    ElMessage.error(knowledgeErrorMessage(err, '批量操作失败'))
  } finally {
    batchBusy.value = false
    batchDone.value = 0
    batchTotal.value = 0
  }
}

async function batchStatus(enabled: boolean): Promise<void> {
  const ids = [...selectedIds.value]
  const label = enabled ? '启用' : '停用'
  try {
    await ElMessageBox.confirm(`确定${label}选中的 ${ids.length} 条知识吗？`, `批量${label}`, {
      type: 'warning',
      confirmButtonText: `批量${label}`,
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await runBatch(
    () =>
      batchSetKnowledgeStatus(ids, enabled, source.value, (done, total) => {
        batchDone.value = done
        batchTotal.value = total
      }),
    `已${label} ${ids.length} 条`,
  )
}

async function batchDelete(): Promise<void> {
  const ids = [...selectedIds.value]
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${ids.length} 条知识吗？删除后不可恢复。`,
      '批量删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  await runBatch(
    () =>
      batchRemoveKnowledgeItems(ids, source.value, (done, total) => {
        batchDone.value = done
        batchTotal.value = total
      }),
    `已删除 ${ids.length} 条`,
  )
}

function pickImportFile(): void {
  if (positionId.value) return
  fileInput.value?.click()
}

async function onImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (positionId.value) { ElMessage.warning('当前岗位视图不支持通用导入，请使用新增岗位问答。'); return }

  try {
    await ElMessageBox.confirm(
      `将把「${file.name}」导入为通用问答，通过校验的内容可能用于所有岗位。CSV 需要包含“问题”和“答案”两列，已存在的问题不会自动去重。是否继续？`,
      '导入知识',
      { type: 'info', confirmButtonText: '开始导入', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  importing.value = true
  importDone.value = 0
  importTotal.value = 0
  try {
    const result = await importKnowledgeFile(file, null, (done, total) => {
      importDone.value = done
      importTotal.value = total
    })
    if (result.created) {
      ElMessage.success(`导入完成：新增 ${result.created} 条${result.failed ? `，失败 ${result.failed} 条` : ''}`)
    } else {
      ElMessage.warning('没有导入任何条目')
    }
    if (result.errors.length) {
      await ElMessageBox.alert(result.errors.slice(0, 10).join('；'), '部分导入失败', {
        type: 'warning',
        confirmButtonText: '知道了',
      }).catch(() => undefined)
    }
    if (result.degraded) {
      ElMessage.info('后端批量导入未接线，已按行逐条写入知识库')
    }
    await load()
  } catch (err) {
    ElMessage.error(knowledgeErrorMessage(err, '导入失败'))
  } finally {
    importing.value = false
    importDone.value = 0
    importTotal.value = 0
  }
}

async function handleExport(): Promise<void> {
  if (!items.value.length) {
    ElMessage.warning('暂无数据可导出')
    return
  }
  if (!filteredItems.value.length) {
    ElMessage.warning('当前筛选条件下没有数据')
    return
  }
  try {
    const result = await exportKnowledge(filteredItems.value, categoryName)
    downloadBlob(result.blob, result.filename)
    if (result.degraded) ElMessage.info('后端导出未接线，已在前端生成 CSV')
    else ElMessage.success('导出已开始')
  } catch (err) {
    ElMessage.error(knowledgeErrorMessage(err, '导出失败'))
  }
}

function onTemplateImported(): void {
  void load()
  faqPanelRef.value?.reload?.()
}

watch([keyword, verticalFilter, statusFilter], () => {
  page.value = 1
})

onMounted(() => {
  void loadOptions()
  void load()
})
</script>

<style scoped>
.stats-row .stat-card {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 6px 16px;
  border-radius: 999px;
}

.stats-row .stat-value {
  font-size: 21px;
  font-weight: 700;
  line-height: 1.2;
}

.stats-row .stat-label {
  margin-top: 0;
  font-size: 12.5px;
}

.kb-tabs :deep(.el-tabs__header) {
  margin-bottom: 18px;
}

.kb-question {
  font-weight: 600;
  color: var(--bd-text-primary);
}

.kb-answer {
  margin-top: 4px;
  max-width: 560px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.kb-keywords {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
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

.kb-file-input {
  display: none;
}

.search-input {
  width: 280px;
}

.status-select {
  width: 140px;
}
</style>
