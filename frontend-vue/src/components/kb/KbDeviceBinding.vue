<template>
  <section class="kb-device">
    <div class="device-toolbar">
      <el-input
        v-model="keyword"
        class="device-search"
        placeholder="搜索设备名称 / 设备码..."
        clearable
        :prefix-icon="Search"
      />
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>
    <el-alert
      class="device-hint"
      type="info"
      show-icon
      :closable="false"
      title="一台设备认一个厂，客户问什么就答哪家的"
    />

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="paged" row-key="id">
        <template #empty>
          <el-empty description="暂无设备" />
        </template>
        <el-table-column label="设备" prop="name" min-width="150" />
        <el-table-column label="设备码" prop="device_code" min-width="130" />
        <el-table-column label="品类" min-width="110">
          <template #default="{ row }">
            {{ lookupName('verticals', row.vertical_id) || '未绑定' }}
          </template>
        </el-table-column>
        <el-table-column label="招工方" min-width="130">
          <template #default="{ row }">
            {{ lookupName('employers', row.employer_id) || '未绑定' }}
          </template>
        </el-table-column>
        <el-table-column label="位置" min-width="110">
          <template #default="{ row }">
            {{ lookupName('locations', row.location_id) || '—' }}
          </template>
        </el-table-column>
        <el-table-column label="岗位" min-width="90">
          <template #default="{ row }">
            {{ row.position_id ? `岗位#${row.position_id}` : '—' }}
          </template>
        </el-table-column>
        <el-table-column label="在线" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.online ? 'success' : 'info'" size="small">
              {{ row.online ? '在线' : '离线' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="条目数" prop="item_count" width="90" align="center" />
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">绑定</el-button>
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

    <el-dialog v-model="editorVisible" title="设备绑定" width="480px" :close-on-click-modal="false">
      <div class="bind-device">{{ editingRow?.name }}（{{ editingRow?.device_code }}）</div>
      <el-form label-position="top">
        <el-form-item label="品类">
          <el-select v-model="draft.vertical_id" class="full" clearable filterable placeholder="（不绑定）">
            <el-option
              v-for="item in verticals"
              :key="item.id"
              :label="String(item.name)"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="招工方">
          <el-select v-model="draft.employer_id" class="full" clearable filterable placeholder="（不绑定）">
            <el-option
              v-for="item in employers"
              :key="item.id"
              :label="String(item.short_name || item.display_name)"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="位置">
          <el-select v-model="draft.location_id" class="full" clearable filterable placeholder="（不绑定）">
            <el-option v-for="item in locations" :key="item.id" :label="String(item.name)" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="岗位 id（position 级问答必填）">
          <el-input-number v-model="draft.position_id" :min="0" class="full" controls-position="right" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editorVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Search } from '@element-plus/icons-vue'
import http from '../../api/http'
import { listEmployers, listLocations, listVerticals } from '../../api/knowledge'
import type { Employer, LocationNode, Vertical } from '../../api/knowledge'

interface DeviceRow {
  id: number
  name?: string
  device_code?: string
  vertical_id?: number
  employer_id?: number
  location_id?: number
  position_id?: number
  online?: boolean
  item_count?: number
}

const devices = ref<DeviceRow[]>([])
const verticals = ref<Vertical[]>([])
const employers = ref<Employer[]>([])
const locations = ref<LocationNode[]>([])
const loading = ref(false)
const saving = ref(false)
const keyword = ref('')
const page = ref(1)
const pageSize = ref(20)
const editorVisible = ref(false)
const editingRow = ref<DeviceRow | null>(null)
const draft = ref({ vertical_id: 0, employer_id: 0, location_id: 0, position_id: 0 })

const filtered = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  if (!key) return devices.value
  return devices.value.filter((row) =>
    `${row.name || ''} ${row.device_code || ''}`.toLowerCase().includes(key),
  )
})

const paged = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

watch([keyword], () => {
  page.value = 1
})

function lookupName(source: 'verticals' | 'employers' | 'locations', id: unknown): string {
  if (!id) return ''
  const list =
    source === 'verticals' ? verticals.value : source === 'employers' ? employers.value : locations.value
  const hit = list.find((row) => Number(row.id) === Number(id)) as Record<string, unknown> | undefined
  if (!hit) return `#${id}`
  return String(hit.short_name || hit.display_name || hit.name || hit.code || `#${id}`)
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const { data } = await http.get<{ items?: DeviceRow[] }>('/api/v1/agent/devices')
    devices.value = data.items || []
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '设备列表加载失败')
  } finally {
    loading.value = false
  }
}

async function loadLookups(): Promise<void> {
  try {
    const [verticalRes, employerRes, locationRes] = await Promise.all([
      listVerticals(),
      listEmployers(),
      listLocations(),
    ])
    verticals.value = verticalRes
    employers.value = employerRes
    locations.value = locationRes
  } catch {
    /* 下拉数据失败不阻塞列表 */
  }
}

function openEdit(row: DeviceRow): void {
  editingRow.value = row
  draft.value = {
    vertical_id: Number(row.vertical_id || 0),
    employer_id: Number(row.employer_id || 0),
    location_id: Number(row.location_id || 0),
    position_id: Number(row.position_id || 0),
  }
  editorVisible.value = true
}

async function save(): Promise<void> {
  if (!editingRow.value) return
  saving.value = true
  try {
    // 0 表示「不绑定」（kb-console 约定：存 null 会让 Number.isInteger 判假）
    await http.put(`/api/v1/agent/devices/${editingRow.value.id}`, { ...draft.value })
    ElMessage.success('绑定已保存')
    editorVisible.value = false
    await load()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '绑定保存失败')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await Promise.all([load(), loadLookups()])
})
</script>

<style scoped>
.device-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.device-search {
  width: 280px;
}

.device-hint {
  margin-bottom: 12px;
}

.bind-device {
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--bd-text-secondary, #5f6b7a);
}

.full {
  width: 100%;
}

.pager {
  display: flex;
  justify-content: flex-end;
  padding: 10px 0 0;
}
</style>
