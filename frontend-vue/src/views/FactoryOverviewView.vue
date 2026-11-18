<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">工厂配置总览</h2>
        <p class="page-desc">只读聚合视图：工厂 → 岗位数 / 设备 / 城市，用于快速核对配置完整度</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ rows.length }}</div>
        <div class="stat-label">工厂总数</div>
      </div>
      <div class="stat-card stat-active">
        <div class="stat-value">{{ positions.length }}</div>
        <div class="stat-label">岗位总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ devices.length }}</div>
        <div class="stat-label">坐席设备</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ cityCount }}</div>
        <div class="stat-label">覆盖城市</div>
      </div>
    </div>

    <div class="filter-bar">
      <el-select v-model="cityFilter" class="filter-select" placeholder="全部城市" clearable>
        <el-option label="全部城市" value="" />
        <el-option v-for="city in cityNames" :key="city" :label="city" :value="city" />
      </el-select>
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索工厂名称..."
        clearable
        :prefix-icon="Search"
      />
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="pagedRows" row-key="id">
        <template #empty>
          <el-empty description="暂无工厂数据，请先在「厂区管理」中创建厂区" />
        </template>
        <el-table-column prop="factory_name" label="工厂" min-width="150">
          <template #default="{ row }">
            <span class="factory-name">{{ row.factory_name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="城市" width="90">
          <template #default="{ row }">{{ row.city_name }}</template>
        </el-table-column>
        <el-table-column label="岗位数" width="80" align="center">
          <template #default="{ row }">
            <el-tag :type="row.position_count ? 'success' : 'info'" effect="plain" size="small">
              {{ row.position_count }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="设备数" width="80" align="center">
          <template #default="{ row }">{{ row.device_count }}</template>
        </el-table-column>
        <el-table-column label="在线设备" width="90" align="center">
          <template #default="{ row }">
            <span :class="row.online_count ? 'online' : 'muted'">{{ row.online_count }}</span>
          </template>
        </el-table-column>
        <el-table-column label="岗位示例" min-width="150">
          <template #default="{ row }">
            <span class="muted">{{ row.sample || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="配置状态" width="100">
          <template #default="{ row }">
            <el-tag :type="statusOf(row)" effect="light">{{ statusText(row) }}</el-tag>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="filteredRows.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, Search } from '@element-plus/icons-vue'
import { citiesApi, factoriesApi, overviewApi, positionsApi, apiErrorMessage } from '../api/core'
import type { AgentDevice, City, Factory, ServicePosition } from '../api/core'
import { toArray } from '../utils/format'

interface OverviewRow {
  id: number
  factory_name: string
  city_name: string
  city_id: number | null
  position_count: number
  device_count: number
  online_count: number
  sample: string
}

const rows = ref<OverviewRow[]>([])
const positions = ref<ServicePosition[]>([])
const devices = ref<AgentDevice[]>([])
const loading = ref(false)
const keyword = ref('')
const cityFilter = ref('')
const page = ref(1)
const pageSize = ref(20)

const cityNames = computed(() => [...new Set(rows.value.map((row) => row.city_name).filter(Boolean))])
const cityCount = computed(() => cityNames.value.length)

const filteredRows = computed(() => {
  const key = keyword.value.trim()
  return rows.value.filter((row) => {
    if (cityFilter.value && row.city_name !== cityFilter.value) return false
    if (key && !row.factory_name.includes(key)) return false
    return true
  })
})

const pagedRows = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredRows.value.slice(start, start + pageSize.value)
})

function statusOf(row: OverviewRow): 'success' | 'warning' | 'info' {
  if (!row.position_count) return 'info'
  if (!row.device_count) return 'warning'
  return 'success'
}

function statusText(row: OverviewRow): string {
  if (!row.position_count) return '无岗位'
  if (!row.device_count) return '未绑设备'
  return '配置完整'
}

function deviceFactoryIds(device: AgentDevice): number[] {
  const ids = new Set<number>()
  const raw = device.factory_ids
  if (Array.isArray(raw)) {
    for (const id of raw) if (Number(id) > 0) ids.add(Number(id))
  }
  const list = device.factories
  if (Array.isArray(list)) {
    for (const item of list) {
      const record = item as Record<string, unknown>
      const id = Number(record.id ?? 0)
      if (id > 0) ids.add(id)
    }
  }
  return [...ids]
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const [factoryRes, positionRes, cityRes, deviceRes] = await Promise.all([
      factoriesApi.list({ page: 1, page_size: 1000 }),
      positionsApi.list({ page: 1, page_size: 1000 }),
      citiesApi.list({ page: 1, page_size: 1000 }).catch(() => ({ data: { items: [] } })),
      overviewApi.devices().catch(() => ({ data: { items: [] } })),
    ])
    const factories = toArray<Factory>(factoryRes.data)
    positions.value = toArray<ServicePosition>(positionRes.data)
    devices.value = toArray<AgentDevice>((deviceRes as { data: unknown }).data)
    const cities = toArray<City>((cityRes as { data: unknown }).data)
    const cityById = new Map(cities.map((city) => [Number(city.id), city.city_name]))

    const positionsByFactory = new Map<number, ServicePosition[]>()
    for (const position of positions.value) {
      if (typeof position.factory_id !== 'number') continue
      const list = positionsByFactory.get(position.factory_id) ?? []
      list.push(position)
      positionsByFactory.set(position.factory_id, list)
    }

    const devicesByFactory = new Map<number, AgentDevice[]>()
    for (const device of devices.value) {
      for (const factoryId of deviceFactoryIds(device)) {
        const list = devicesByFactory.get(factoryId) ?? []
        list.push(device)
        devicesByFactory.set(factoryId, list)
      }
    }

    rows.value = factories.map((factory) => {
      const cityId = typeof factory.city_id === 'number' ? factory.city_id : null
      const list = positionsByFactory.get(factory.id) ?? []
      const deviceList = devicesByFactory.get(factory.id) ?? []
      return {
        id: factory.id,
        factory_name: factory.factory_name,
        city_id: cityId,
        city_name: cityId ? cityById.get(cityId) || '-' : '-',
        position_count: list.length,
        device_count: deviceList.length,
        online_count: deviceList.filter((item) => item.online || item.status).length,
        sample: list
          .slice(0, 2)
          .map((item) => item.position_name)
          .join('、'),
      }
    })
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '工厂总览加载失败'))
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.factory-name {
  font-weight: 600;
  color: var(--bd-text-primary);
}

.filter-select {
  width: 150px;
}

.search-input {
  width: 260px;
}

.online {
  color: #12a150;
  font-weight: 600;
}
</style>
