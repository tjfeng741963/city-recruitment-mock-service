<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">招聘岗位</h2>
        <p class="page-desc">维护各城市的岗位、招聘资料和面试安排</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Upload" @click="importVisible = true">鲸才导入 / 导入导出</el-button>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">添加岗位</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ positions.length }}</div>
        <div class="stat-label">总岗位</div>
      </div>
      <div class="stat-card stat-active">
        <div class="stat-value">{{ activeCount }}</div>
        <div class="stat-label">启用中</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ featuredCount }}</div>
        <div class="stat-label">主推岗位</div>
      </div>
    </div>

    <div class="filter-bar">
      <el-select v-model="featuredFilter" class="filter-select" placeholder="全部">
        <el-option label="全部" value="" />
        <el-option label="仅看主推" value="featured" />
      </el-select>
      <el-select v-model="cityFilter" class="filter-select" placeholder="全部城市" clearable>
        <el-option label="全部城市" value="" />
        <el-option v-for="city in cityOptions" :key="city" :label="city" :value="city" />
      </el-select>
      <el-select v-model="statusFilter" class="filter-select" placeholder="全部状态" clearable>
        <el-option label="全部状态" value="" />
        <el-option label="启用" value="active" />
        <el-option label="停用" value="inactive" />
      </el-select>
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索岗位名称..."
        clearable
        :prefix-icon="Search"
      />
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="pagedPositions" row-key="id">
        <template #empty>
          <el-empty description="暂无岗位数据，点击右上角「添加岗位」开始配置" />
        </template>
        <el-table-column label="主推" width="50" align="center">
          <template #default="{ row }">
            <el-icon class="star" :class="{ featured: row.is_featured }" @click="toggleFeatured(row)">
              <StarFilled v-if="row.is_featured" />
              <Star v-else />
            </el-icon>
          </template>
        </el-table-column>
        <el-table-column label="岗位名称" width="175">
          <template #default="{ row }">
            <div class="position-name">{{ row.position_name }}</div>

          </template>
        </el-table-column>
        <el-table-column label="工厂" width="120">
          <template #default="{ row }">
            <span class="muted">{{ factoryName(row.factory_id) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="gender" label="性别" width="80">
          <template #default="{ row }">{{ row.gender || '不限' }}</template>
        </el-table-column>
        <el-table-column prop="job_type" label="类型" width="70">
          <template #default="{ row }">{{ row.job_type || '全职' }}</template>
        </el-table-column>
        <el-table-column label="住宿" width="170">
          <template #default="{ row }">
            <span v-if="row.accommodation" class="wrap-cell accent">{{ row.accommodation }}</span>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="年龄" width="150">
          <template #default="{ row }">
            <span class="wrap-cell">{{ row.age_range || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="city_name" label="城市" width="80" />
        <el-table-column label="开场条数" width="80" align="center">
          <template #default="{ row }">
            <span class="muted">{{ row.opening_count }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="70" align="center">
          <template #default="{ row }">
            <el-switch
              :model-value="row.is_active"
              :loading="row.saving"
              @change="(value: boolean) => toggleActive(row, value)"
            />
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="150">
          <template #default="{ row }">
            <span class="muted">{{ formatDateTime(row.updated_at) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑岗位</el-button>
            <el-button link type="primary" @click="openCopy(row)">复制</el-button>
            <el-button link type="primary" @click="router.push(positionLink('/recruitment-flow', row.id))">话术流程</el-button>
            <el-dropdown trigger="click" @command="(cmd: string) => onCommand(cmd, row)">
              <el-button link type="primary">更多</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="binding">厂区绑定</el-dropdown-item>
                  <el-dropdown-item command="holidays">岗位节假日</el-dropdown-item>
                  <el-dropdown-item command="delete" divided>删除岗位</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="filteredPositions.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </div>

    <PositionFormDrawer
      v-model="formVisible"
      :mode="formMode"
      :position-id="activePositionId"
      @saved="load"
    />
    <PositionImportDialog v-model="importVisible" @imported="load" />
    <PositionFactoryBindingDialog
      v-model="bindingVisible"
      :position-id="activePositionId"
      :position-name="activePositionName"
      @saved="load"
    />
    <PositionHolidaysDialog
      v-model="holidaysVisible"
      :position-id="activePositionId"
      :position-name="activePositionName"
      @changed="load"
    />

  </section>
</template>

<script setup lang="ts">
import {  computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { positionLink } from '../layouts/navigation'
import { Plus, Refresh, Search, Star, StarFilled, Upload } from '@element-plus/icons-vue'
import { citiesApi, factoriesApi, positionsApi, apiErrorMessage } from '../api/core'
import type { City, Factory, ServicePosition } from '../api/core'
import { formatDateTime, toArray } from '../utils/format'
import PositionFormDrawer from '../components/basic/PositionFormDrawer.vue'
import PositionImportDialog from '../components/basic/PositionImportDialog.vue'
import PositionFactoryBindingDialog from '../components/basic/PositionFactoryBindingDialog.vue'
import PositionHolidaysDialog from '../components/basic/PositionHolidaysDialog.vue'

const router = useRouter()
interface PositionRow extends ServicePosition {
  opening_count: number
  saving?: boolean
}

interface PersonaSummary {
  position_id: number
  has_persona: boolean
  opening_count: number
}

const positions = ref<PositionRow[]>([])
const factories = ref<Factory[]>([])
const cities = ref<City[]>([])
const loading = ref(false)
const keyword = ref('')
const featuredFilter = ref('')
const cityFilter = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)

const formVisible = ref(false)
const importVisible = ref(false)
const bindingVisible = ref(false)
const holidaysVisible = ref(false)
const formMode = ref<'create' | 'edit' | 'copy'>('create')
const activePositionId = ref<number | null>(null)
const activePositionName = ref('')

const activeCount = computed(() => positions.value.filter((item) => item.is_active).length)
const featuredCount = computed(() => positions.value.filter((item) => item.is_featured).length)

const cityOptions = computed(() => {
  const names = new Set<string>()
  for (const city of cities.value) if (city.city_name) names.add(city.city_name)
  for (const position of positions.value) if (position.city_name) names.add(position.city_name)
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'))
})

const filteredPositions = computed(() => {
  const key = keyword.value.trim()
  return positions.value.filter((item) => {
    if (featuredFilter.value === 'featured' && !item.is_featured) return false
    if (cityFilter.value && item.city_name !== cityFilter.value) return false
    if (statusFilter.value === 'active' && !item.is_active) return false
    if (statusFilter.value === 'inactive' && item.is_active) return false
    if (key && !item.position_name.includes(key)) return false
    return true
  })
})

const pagedPositions = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredPositions.value.slice(start, start + pageSize.value)
})


// 筛选变化时回到第 1 页，避免停在空页
watch([[keyword], [featuredFilter], [cityFilter], [statusFilter]], () => {
  page.value = 1
})

function factoryName(id: unknown): string {
  if (typeof id !== 'number') return '-'
  return factories.value.find((factory) => factory.id === id)?.factory_name || '-'
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const [positionRes, factoryRes, cityRes, personaRes] = await Promise.all([
      positionsApi.list({ page: 1, page_size: 1000 }),
      factoriesApi.list({ page: 1, page_size: 1000 }).catch(() => ({ data: { items: [] } })),
      citiesApi.list({ page: 1, page_size: 1000 }).catch(() => ({ data: { items: [] } })),
      positionsApi.personaSummary().catch(() => ({ data: { items: [] } })),
    ])

    factories.value = toArray<Factory>((factoryRes as { data: unknown }).data)
    cities.value = toArray<City>((cityRes as { data: unknown }).data)
    const personaMap = new Map(
      toArray<PersonaSummary>((personaRes as { data: unknown }).data).map((item) => [item.position_id, item]),
    )
    positions.value = toArray<ServicePosition>(positionRes.data).map((position) => ({
      ...position,
      opening_count: personaMap.get(position.id)?.opening_count ?? 0,
    }))
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '岗位列表加载失败'))
  } finally {
    loading.value = false
  }
}

async function toggleActive(row: PositionRow, value: boolean): Promise<void> {
  row.saving = true
  try {
    await positionsApi.update(row.id, { is_active: value })
    row.is_active = value
    ElMessage.success(value ? '岗位已启用' : '岗位已停用')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '状态更新失败'))
  } finally {
    row.saving = false
  }
}

async function toggleFeatured(row: PositionRow): Promise<void> {
  try {
    const { data } = await positionsApi.toggleFeatured(row.id)
    row.is_featured = Boolean(data.is_featured)
    ElMessage.success(row.is_featured ? '已设为主推' : '已取消主推')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '主推更新失败'))
  }
}

function openCreate(): void {
  formMode.value = 'create'
  activePositionId.value = null
  formVisible.value = true
}

function openEdit(row: PositionRow): void {
  formMode.value = 'edit'
  activePositionId.value = row.id
  formVisible.value = true
}

function openCopy(row: PositionRow): void {
  formMode.value = 'copy'
  activePositionId.value = row.id
  formVisible.value = true
}

async function onCommand(command: string, row: PositionRow): Promise<void> {
  if (command === 'delete') return removePosition(row)
  activePositionId.value = row.id
  activePositionName.value = row.position_name
  if (command === 'binding') bindingVisible.value = true
  if (command === 'holidays') holidaysVisible.value = true
}

async function removePosition(row: PositionRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除岗位「${row.position_name}」吗？该操作不可撤销。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await positionsApi.remove(row.id)
    ElMessage.success('岗位已删除')
    await load()
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '删除失败'))
  }
}

onMounted(load)
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

.wrap-cell {
  display: block;
  white-space: normal;
  line-height: 1.5;
  word-break: break-word;
}

.wrap-cell.accent {
  color: var(--bd-primary, #0b57d0);
}

.filter-select {
  width: 150px;
}

.search-input {
  width: 260px;
}

.position-name {
  font-weight: 600;
  color: var(--bd-text-primary);
  line-height: 1.4;
}

.star {
  color: var(--bd-text-tertiary);
  cursor: pointer;
}

.star.featured {
  color: #f5a623;
}

.ellipsis {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
