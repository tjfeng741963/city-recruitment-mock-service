<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">城市</h2>
        <p class="page-desc">管理城市与区县，打开对应的招聘岗位。</p>
      </div>
      <div class="header-actions">
        <el-dropdown trigger="click" @command="openCityTool">
          <el-button>更多工具 <el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="/city-links">地域与周边城市</el-dropdown-item>
              <el-dropdown-item command="/factory-overview">招聘配置检查</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">添加城市</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ cities.length }}</div>
        <div class="stat-label">总城市数</div>
      </div>
      <div class="stat-card stat-active">
        <div class="stat-value">{{ activeCount }}</div>
        <div class="stat-label">已配置接待</div>
      </div>
      <div class="stat-card stat-inactive">
        <div class="stat-value">{{ inactiveCount }}</div>
        <div class="stat-label">未配置接待</div>
      </div>
    </div>

    <div class="filter-bar">
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索城市名称..."
        clearable
        :prefix-icon="Search"
      />
      <el-select v-model="statusFilter" class="status-select" placeholder="接待配置" clearable>
        <el-option label="全部接待状态" value="" />
        <el-option label="已配置接待" value="active" />
        <el-option label="未配置接待" value="inactive" />
      </el-select>
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="pagedCities" row-key="id">
        <template #empty>
          <el-empty description="暂无城市数据，点击右上角「添加城市」开始配置" />
        </template>
        <el-table-column prop="city_name" label="城市" min-width="120">
          <template #default="{ row }">
            <span class="city-name">{{ row.city_name }}</span>
            <el-tag v-if="row.is_primary" class="primary-chip" size="small" type="warning" effect="plain">
              主推
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="接待配置" min-width="125">
          <template #default="{ row }">
            <el-tooltip :content="row.recruitment_status === 'active'
              ? '有已启用的设备绑定本城的已启用岗位。在线情况可到微信账号查看。'
              : '暂无已启用的设备绑定本城的已启用岗位。可从查看岗位核对岗位状态。'">
              <el-tag :type="row.recruitment_status === 'active' ? 'success' : 'info'" effect="light">
                {{ row.recruitment_status === 'active' ? '已配置接待' : '未配置接待' }}
              </el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="province" label="省份" min-width="110" />
        <el-table-column label="更新时间" width="180">
          <template #default="{ row }">
            <span class="muted">{{ formatDateTime(row.updated_at) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="250" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="router.push(cityPositionsLink(row.id))">查看岗位</el-button>
            <el-button link @click="openEdit(row)">编辑城市</el-button>
            <el-dropdown trigger="click" @command="(cmd: string) => onCommand(cmd, row)">
              <el-button link type="primary">更多</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="factories">厂区（{{ row.factory_count }}）</el-dropdown-item>
                  <el-dropdown-item command="history">历史记录</el-dropdown-item>
                  <el-dropdown-item command="copy">复制城市</el-dropdown-item>
                  <el-dropdown-item command="delete" divided>删除城市</el-dropdown-item>
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
          :total="filteredCities.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </div>

    <CityFormDrawer
      v-model="formVisible"
      :mode="formMode"
      :city-id="activeCityId"
      @saved="load"
    />
    <CityFactoryDrawer
      v-model="factoryVisible"
      :city-id="activeCityId"
      :city-name="activeCityName"
      @changed="load"
    />
    <CityHistoryDrawer
      v-model="historyVisible"
      :city-id="activeCityId"
      :city-name="activeCityName"
      @restored="load"
    />
  </section>
</template>

<script setup lang="ts">
import {  computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search, ArrowDown } from '@element-plus/icons-vue'
import { citiesApi, factoriesApi, apiErrorMessage } from '../api/core'
import type { City, Factory } from '../api/core'
import { formatDateTime, toArray } from '../utils/format'
import { useRouter } from 'vue-router'
import { cityPositionsLink } from '../layouts/navigation'
import CityFormDrawer from '../components/basic/CityFormDrawer.vue'
import CityFactoryDrawer from '../components/basic/CityFactoryDrawer.vue'
import CityHistoryDrawer from '../components/basic/CityHistoryDrawer.vue'

interface CityRow extends City {
  factory_count: number
}

const router = useRouter()
const cities = ref<CityRow[]>([])
const loading = ref(false)
const keyword = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)

const formVisible = ref(false)
const factoryVisible = ref(false)
const historyVisible = ref(false)
const formMode = ref<'create' | 'edit' | 'copy'>('create')
const activeCityId = ref<number | null>(null)
const activeCityName = ref('')

const activeCount = computed(() => cities.value.filter((city) => city.recruitment_status === 'active').length)
const inactiveCount = computed(() => cities.value.filter((city) => city.recruitment_status !== 'active').length)

const filteredCities = computed(() => {
  const key = keyword.value.trim()
  return cities.value.filter((city) => {
    if (statusFilter.value && city.recruitment_status !== statusFilter.value) return false
    if (key && !city.city_name.includes(key)) return false
    return true
  })
})

const pagedCities = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredCities.value.slice(start, start + pageSize.value)
})


// 筛选变化时回到第 1 页，避免停在空页
watch([[keyword], [statusFilter]], () => {
  page.value = 1
})

function openCityTool(path: string): void {
  if (path === '/city-links' || path === '/factory-overview') void router.push(path)
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const [cityRes, factoryRes] = await Promise.all([
      citiesApi.list({ page: 1, page_size: 1000 }),
      factoriesApi.list({ page: 1, page_size: 1000 }),
    ])
    // 厂区列表一次取回后按城市聚合，避免逐城市请求（N+1）
    const countByCity = new Map<number, number>()
    for (const factory of toArray<Factory>(factoryRes.data)) {
      if (factory.city_id) {
        countByCity.set(factory.city_id, (countByCity.get(factory.city_id) || 0) + 1)
      }
    }
    cities.value = toArray<City>(cityRes.data).map((city) => ({
      ...city,
      factory_count: countByCity.get(city.id) || 0,
    }))
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '城市列表加载失败'))
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  formMode.value = 'create'
  activeCityId.value = null
  formVisible.value = true
}

function openEdit(row: CityRow): void {
  formMode.value = 'edit'
  activeCityId.value = row.id
  formVisible.value = true
}

function openCopy(row: CityRow): void {
  formMode.value = 'copy'
  activeCityId.value = row.id
  formVisible.value = true
}

function openFactories(row: CityRow): void {
  activeCityId.value = row.id
  activeCityName.value = row.city_name
  factoryVisible.value = true
}

function openHistory(row: CityRow): void {
  activeCityId.value = row.id
  activeCityName.value = row.city_name
  historyVisible.value = true
}

async function onCommand(command: string, row: CityRow): Promise<void> {
  if (command === 'factories') openFactories(row)
  if (command === 'history') openHistory(row)
  if (command === 'copy') openCopy(row)
  if (command === 'delete') await removeCity(row)
}

async function removeCity(row: CityRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除城市「${row.city_name}」吗？城市下若有厂区或岗位将无法删除。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await citiesApi.remove(row.id)
    ElMessage.success('城市已删除')
    await load()
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '删除失败'))
  }
}

onMounted(load)
</script>

<style scoped>
.city-name {
  font-weight: 600;
  color: var(--bd-text-primary);
}

.primary-chip {
  margin-left: 6px;
}

.search-input {
  width: 280px;
}

.status-select {
  width: 150px;
}
</style>
