<template>
  <el-drawer
    :model-value="modelValue"
    :title="`历史与回滚 · ${cityName}`"
    size="760px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="load"
  >
    <div class="drawer-toolbar">
      <span class="hint">每次编辑城市都会生成一条快照，可回滚到任意历史版本</span>
      <el-button :icon="Refresh" @click="load">刷新</el-button>
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="entries" row-key="id">
        <template #empty>
          <el-empty description="暂无历史记录，编辑一次城市后即可生成快照" />
        </template>
        <el-table-column label="快照时间" width="180">
          <template #default="{ row }">
            <span class="muted">{{ row.created_at || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="城市名称" min-width="120">
          <template #default="{ row }">{{ snapshotOf(row).city_name || '-' }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="snapshotOf(row).recruitment_status === 'active' ? 'success' : 'info'" effect="light">
              {{ snapshotOf(row).recruitment_status === 'active' ? '招聘中' : '已停止' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="区域数" width="90" align="center">
          <template #default="{ row }">
            {{ Array.isArray(snapshotOf(row).districts) ? (snapshotOf(row).districts as unknown[]).length : 0 }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="showDetail(row)">查看</el-button>
            <el-button link type="warning" @click="restore(row)">回滚</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="total"
          layout="total, sizes, prev, pager, next"
          @current-change="load"
          @size-change="load"
        />
      </div>
    </div>

    <el-dialog v-model="detailVisible" title="快照详情" width="640px" append-to-body>
      <el-descriptions v-if="detail" :column="2" border size="small">
        <el-descriptions-item label="城市名称">{{ detail.city_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="省份">{{ detail.province || '-' }}</el-descriptions-item>
        <el-descriptions-item label="招聘状态">
          {{ detail.recruitment_status === 'active' ? '招聘中' : '已停止' }}
        </el-descriptions-item>
        <el-descriptions-item label="面试点">{{ detail.interview_site_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="主线路" :span="2">
          {{ Array.isArray(detail.available_lines) && detail.available_lines.length ? (detail.available_lines as string[]).join('、') : '-' }}
        </el-descriptions-item>
        <el-descriptions-item label="区域" :span="2">
          {{ Array.isArray(detail.districts) && detail.districts.length ? (detail.districts as string[]).join('、') : '-' }}
        </el-descriptions-item>
      </el-descriptions>
      <pre class="raw-json">{{ rawText }}</pre>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button type="warning" @click="restoreDetail">回滚到此版本</el-button>
      </template>
    </el-dialog>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { citiesApi, apiErrorMessage } from '../../api/core'
import type { CityHistoryEntry } from '../../api/core'
import { formatDateTime } from '../../utils/format'

const props = defineProps<{
  modelValue: boolean
  cityId: number | null
  cityName: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'restored'): void
}>()

const entries = ref<CityHistoryEntry[]>([])
const loading = ref(false)
const page = ref(1)
const pageSize = ref(20)
const total = ref(0)
const detailVisible = ref(false)
const detail = ref<Record<string, unknown> | null>(null)
const detailEntry = ref<CityHistoryEntry | null>(null)

const rawText = computed(() => (detail.value ? JSON.stringify(detail.value, null, 2) : ''))
const cityName = computed(() => props.cityName || '-')

function parseSnapshot(row: CityHistoryEntry): Record<string, unknown> {
  if (row.snapshot_json && typeof row.snapshot_json === 'string') {
    try {
      const parsed = JSON.parse(row.snapshot_json)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return row as unknown as Record<string, unknown>
}

function snapshotOf(row: CityHistoryEntry): Record<string, unknown> {
  return parseSnapshot(row)
}

async function load(): Promise<void> {
  if (!props.cityId) return
  loading.value = true
  try {
    const { data } = await citiesApi.history(props.cityId, { page: page.value, page_size: pageSize.value })
    entries.value = (data.items || []) as CityHistoryEntry[]
    total.value = Number(data.total ?? 0)
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '历史记录加载失败'))
  } finally {
    loading.value = false
  }
}

function showDetail(row: CityHistoryEntry): void {
  detailEntry.value = row
  detail.value = { ...parseSnapshot(row), snapshot_at: formatDateTime(row.created_at) }
  detailVisible.value = true
}

function restoreDetail(): void {
  if (detailEntry.value) restore(detailEntry.value)
}

async function restore(row: CityHistoryEntry): Promise<void> {
  try {
    await ElMessageBox.confirm('回滚会用该快照覆盖当前城市配置，确定继续吗？', '回滚确认', {
      type: 'warning',
      confirmButtonText: '回滚',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await citiesApi.restore(props.cityId as number, row.id)
    ElMessage.success('已回滚到所选版本')
    detailVisible.value = false
    await load()
    emit('restored')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '回滚失败'))
  }
}

defineExpose({ load })
</script>

<style scoped>
.drawer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.hint {
  font-size: 12px;
  color: var(--bd-text-tertiary);
}

.raw-json {
  margin-top: 12px;
  max-height: 260px;
  overflow: auto;
  padding: 12px;
  border-radius: 8px;
  background: #f7f8fa;
  font-size: 12px;
  line-height: 1.6;
  color: var(--bd-text-secondary, #4b5563);
}
</style>
