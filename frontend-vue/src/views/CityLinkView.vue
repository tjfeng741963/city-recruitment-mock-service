<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">周边城市设置</h2>
        <p class="page-desc">
          配置每个负责城市的周边城市（可多选）。客户在负责城市没有合适岗位时，AI
          会推荐对应负责城市的周边城市岗位。区域列表用于把客户上报的区县关联到城市。
        </p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Check" :loading="saving" @click="saveConfig">保存配置</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ rows.length }}</div>
        <div class="stat-label">负责城市</div>
      </div>
      <div class="stat-card stat-active">
        <div class="stat-value">{{ linkedCount }}</div>
        <div class="stat-label">已配置周边</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ districtCount }}</div>
        <div class="stat-label">区域总数</div>
      </div>
    </div>

    <div class="filter-bar">
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索负责城市..."
        clearable
        :prefix-icon="Search"
      />
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="pagedRows" row-key="city">
        <template #empty>
          <el-empty description="暂无城市数据，请先在「城市管理」中创建城市" />
        </template>
        <el-table-column prop="city" label="负责城市" width="180">
          <template #default="{ row }">
            <span class="city-name">{{ row.city }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="count" label="岗位数" width="110" align="center" />
        <el-table-column label="周边城市（可多选）" min-width="320">
          <template #default="{ row }">
            <el-select
              v-model="row.linked"
              class="full"
              multiple
              filterable
              collapse-tags
              collapse-tags-tooltip
              placeholder="选择周边城市"
            >
              <el-option
                v-for="option in candidateCities(row)"
                :key="option"
                :label="option"
                :value="option"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="区域" width="150" align="center">
          <template #default="{ row }">
            <el-button link type="primary" @click="openDistricts(row)">
              {{ row.districts.length }} 个区县
            </el-button>
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

    <CityLinkDistrictsDialog
      v-model="districtVisible"
      :city-name="activeCity"
      :districts="activeDistricts"
      @save="applyDistricts"
    />
  </section>
</template>

<script setup lang="ts">
import {  computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, Refresh, Search } from '@element-plus/icons-vue'
import { cityLinksApi, apiErrorMessage } from '../api/core'
import type { CityLinkOption } from '../api/core'
import CityLinkDistrictsDialog from '../components/basic/CityLinkDistrictsDialog.vue'

interface LinkRow {
  city: string
  count: number
  linked: string[]
  districts: string[]
}

const rows = ref<LinkRow[]>([])
const options = ref<CityLinkOption[]>([])
const loading = ref(false)
const saving = ref(false)
const keyword = ref('')
const page = ref(1)
const pageSize = ref(20)
const districtVisible = ref(false)
const activeCity = ref('')
const activeDistricts = ref<string[]>([])

const filteredRows = computed(() => {
  const key = keyword.value.trim()
  return rows.value.filter((row) => (key ? row.city.includes(key) : true))
})

const pagedRows = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredRows.value.slice(start, start + pageSize.value)
})

const linkedCount = computed(() => rows.value.filter((row) => row.linked.length > 0).length)
const districtCount = computed(() => rows.value.reduce((total, row) => total + row.districts.length, 0))


// 筛选变化时回到第 1 页，避免停在空页
watch([[keyword]], () => {
  page.value = 1
})

function candidateCities(row: LinkRow): string[] {
  return options.value.map((item) => item.city).filter((city) => city !== row.city)
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const [linkRes, optionRes] = await Promise.all([cityLinksApi.list(), cityLinksApi.options()])
    const links = linkRes.data.links || {}
    const districts = linkRes.data.districts || {}
    const defaults = optionRes.data.default_districts || {}
    options.value = optionRes.data.options || []
    rows.value = options.value.map((option) => ({
      city: option.city,
      count: Number(option.count ?? 0),
      linked: [...(links[option.city] || [])],
      districts: [...(districts[option.city] ?? defaults[option.city] ?? [])],
    }))
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '周边城市配置加载失败'))
  } finally {
    loading.value = false
  }
}

function openDistricts(row: LinkRow): void {
  activeCity.value = row.city
  activeDistricts.value = [...row.districts]
  districtVisible.value = true
}

function applyDistricts(districts: string[]): void {
  const row = rows.value.find((item) => item.city === activeCity.value)
  if (row) row.districts = districts
}

async function saveConfig(): Promise<void> {
  saving.value = true
  try {
    const payload = {
      links: rows.value.map((row) => ({
        source_city: row.city,
        target_cities: [...row.linked],
        districts: [...row.districts],
      })),
    }
    const { data } = await cityLinksApi.batch(payload)
    ElMessage.success(`配置已保存，共写入 ${data.saved ?? 0} 条关联`)
    await load()
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '保存失败'))
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.city-name {
  font-weight: 600;
  color: var(--bd-text-primary);
}

.search-input {
  width: 280px;
}

.full {
  width: 100%;
}
</style>
