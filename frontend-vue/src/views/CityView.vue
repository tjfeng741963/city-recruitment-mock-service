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
      <el-table v-loading="loading" :data="pagedCities" row-key="id" highlight-current-row
        :current-row-key="returnCityId ?? undefined">
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
        <el-table-column label="接待配置" min-width="155">
          <template #default="{ row }">
            <el-tooltip :content="row.recruitment_status === 'active'
              ? '有已启用的账号绑定本城的已启用岗位。'
              : '还没有已启用的账号绑定本城的已启用岗位。'">
              <el-tag :type="row.recruitment_status === 'active' ? 'success' : 'info'" effect="light">
                {{ row.recruitment_status === 'active' ? '已配置接待' : '未配置接待' }}
              </el-tag>
            </el-tooltip>
            <div v-if="row.recruitment_status !== 'active'" class="reception-action">
              <el-button link type="primary" @click="openReception(row)">设置招聘接待</el-button>
            </div>
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

    <el-dialog
      v-model="receptionVisible"
      :title="`${receptionCity?.city_name || ''} · 设置招聘接待`"
      width="min(calc(100vw - 32px), 520px)"
      :close-on-click-modal="false"
      @closed="closeReception"
    >
      <div v-loading="receptionLoading" class="reception-content">
        <h3 v-if="receptionStep === 'position'">第 1 步 · 选择接待岗位</h3>
        <h3 v-else>第 2 步 · 选择接待账号</h3>
        <el-alert v-if="receptionError" :title="receptionError" :closable="false" type="error" show-icon />
        <template v-else-if="receptionStep === 'position'">
          <p v-if="!receptionLoading && !receptionPositions.length">
            这座城市还没有启用的岗位。先到招聘岗位添加或启用岗位，再回来设置接待。
          </p>
          <el-form v-else label-position="top">
            <el-form-item label="接待岗位">
              <el-select v-model="receptionPositionId" placeholder="选择本城市的启用岗位" filterable>
                <el-option v-for="position in receptionPositions" :key="position.id"
                  :value="position.id" :label="position.position_name" />
              </el-select>
            </el-form-item>
          </el-form>
        </template>
        <template v-else>
          <p>接待岗位：<strong>{{ receptionPosition?.position_name }}</strong></p>
          <el-form label-position="top">
            <el-form-item label="接待账号">
              <el-select v-model="receptionAccountId" placeholder="选择负责这个岗位的账号" filterable>
                <el-option v-for="account in receptionAccounts" :key="account.id" :value="account.id"
                  :label="receptionAccountLabel(account)" />
                <el-option v-if="auth.user?.role === 'admin'" value="new" label="连接新账号" />
              </el-select>
            </el-form-item>
          </el-form>
          <p v-if="!receptionLoading && !receptionAccounts.length && auth.user?.role !== 'admin'">
            当前没有可设置的接待账号，请联系管理员连接账号。
          </p>
          <p v-else-if="receptionAccountId === 'new'">保存绑定后，还需要连接客户端并登录企业微信。</p>
          <p v-else-if="chosenAccount?.position_id && Number(chosenAccount.position_id) !== receptionPositionId">
            该账号已绑定其他岗位。保存接待设置后，所选岗位将替换原绑定。
          </p>
        </template>
      </div>
      <template #footer>
        <el-button v-if="receptionStep === 'position'" @click="receptionVisible = false">取消</el-button>
        <el-button v-else :disabled="receptionLoading" @click="receptionStep = 'position'">上一步</el-button>
        <el-button v-if="receptionError" type="primary" @click="retryReception">重试</el-button>
        <el-button v-else-if="receptionStep === 'position' && !receptionLoading && !receptionPositions.length"
          type="primary" @click="receptionCity && router.push(cityPositionsLink(receptionCity.id))">查看岗位</el-button>
        <el-button v-else-if="receptionStep === 'position'" type="primary"
          :disabled="!receptionPositionId" :loading="receptionLoading" @click="chooseReceptionAccount">下一步</el-button>
        <el-button v-else type="primary" :disabled="!receptionAccountId" :loading="receptionLoading"
          @click="continueReception">下一步</el-button>
      </template>
    </el-dialog>

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
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search, ArrowDown } from '@element-plus/icons-vue'
import { citiesApi, factoriesApi, positionsApi, apiErrorMessage } from '../api/core'
import type { City, Factory } from '../api/core'
import { devicesApi, type AgentDeviceItem } from '../api/agent'
import type { ServicePosition } from '../api/types'
import { formatDateTime, toArray } from '../utils/format'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { cityPositionsLink } from '../layouts/navigation'
import { deviceOnline } from '../components/agent/device-workflow-entry'
import {
  cityReceptionAccountLink, cityReceptionAccounts, cityReceptionPositions, cityReceptionReturnLink, readCityReceptionId,
} from '../components/basic/city-reception'
import CityFormDrawer from '../components/basic/CityFormDrawer.vue'
import CityFactoryDrawer from '../components/basic/CityFactoryDrawer.vue'
import CityHistoryDrawer from '../components/basic/CityHistoryDrawer.vue'

interface CityRow extends City {
  factory_count: number
}

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const returnCityId = readCityReceptionId(route.query.reception_city)
const returnPositionId = readCityReceptionId(route.query.position_id)
const cities = ref<CityRow[]>([])
const loading = ref(false)
const keyword = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)

const formVisible = ref(false)
const factoryVisible = ref(false)
const historyVisible = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const activeCityId = ref<number | null>(null)
const activeCityName = ref('')
const receptionVisible = ref(false)
const receptionLoading = ref(false)
const receptionError = ref('')
const receptionCity = ref<CityRow | null>(null)
const receptionStep = ref<'position' | 'account'>('position')
const receptionPositions = ref<ServicePosition[]>([])
const receptionPositionId = ref<number | null>(null)
const receptionAccounts = ref<AgentDeviceItem[]>([])
const receptionAccountId = ref<number | 'new' | null>(null)
const receptionPosition = computed(() => receptionPositions.value.find(position => position.id === receptionPositionId.value))
const chosenAccount = computed(() => receptionAccounts.value.find(account => account.id === receptionAccountId.value))
let receptionRequest = 0

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
watch([keyword, statusFilter], () => {
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

async function openReception(city: CityRow, resumePositionId: number | null = null): Promise<void> {
  const request = ++receptionRequest
  receptionCity.value = city
  receptionStep.value = 'position'
  receptionPositions.value = []
  receptionPositionId.value = null
  receptionAccounts.value = []
  receptionAccountId.value = null
  receptionError.value = ''
  receptionLoading.value = true
  receptionVisible.value = true
  try {
    const { data } = await positionsApi.list({ page: 1, page_size: 1000, city_name: city.city_name })
    if (request !== receptionRequest) return
    receptionPositions.value = cityReceptionPositions(data.items || [], city.id)
  } catch (error) {
    if (request === receptionRequest) receptionError.value = apiErrorMessage(error, '岗位加载失败')
  } finally {
    if (request === receptionRequest) receptionLoading.value = false
  }
  if (request === receptionRequest && receptionVisible.value &&
    receptionPositions.value.some(position => position.id === resumePositionId)) {
    receptionPositionId.value = resumePositionId
    await chooseReceptionAccount()
  }
}

async function chooseReceptionAccount(): Promise<void> {
  if (!receptionPosition.value) return
  const request = ++receptionRequest
  receptionStep.value = 'account'
  receptionError.value = ''
  receptionLoading.value = true
  try {
    const { data } = await devicesApi.list()
    if (request === receptionRequest) receptionAccounts.value = cityReceptionAccounts(data.items || [])
  } catch (error) {
    if (request === receptionRequest) receptionError.value = apiErrorMessage(error, '账号加载失败')
  } finally {
    if (request === receptionRequest) receptionLoading.value = false
  }
}

function receptionAccountLabel(account: AgentDeviceItem): string {
  const name = account.name || account.device_name || account.device_code
  const code = name === account.device_code ? '' : ` · ${account.device_code}`
  const current = receptionPositions.value.find(position => position.id === Number(account.position_id))
  const binding = current?.position_name || (account.position_id ? '其他岗位' : '未绑定岗位')
  return `${name}${code} · ${deviceOnline(account) ? '在线' : '离线'} · ${binding}`
}

function retryReception(): void {
  if (receptionStep.value === 'account') void chooseReceptionAccount()
  else if (receptionCity.value) void openReception(receptionCity.value)
}

function continueReception(): void {
  if (!receptionCity.value || !receptionPosition.value || !receptionAccountId.value) return
  const link = cityReceptionAccountLink(
    receptionCity.value.id, receptionPosition.value.id, receptionAccountId.value,
  )
  void (returnPositionId ? router.replace(link) : router.push(link))
}

function closeReception(): void {
  if (returnCityId && returnPositionId && route.name === 'cities') {
    void router.replace(cityReceptionReturnLink(returnCityId))
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

onMounted(async () => {
  await load()
  if (!returnCityId) return
  const index = cities.value.findIndex(city => city.id === returnCityId)
  if (index < 0) return
  page.value = Math.floor(index / pageSize.value) + 1
  const city = cities.value[index]
  if (returnPositionId && city) await openReception(city, returnPositionId)
})
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

.reception-action {
  margin-top: 4px;
}

.reception-content {
  min-height: 108px;
}

.reception-content h3 {
  margin: 0 0 12px;
  font-size: 15px;
}

.reception-content .el-select {
  width: 100%;
}
</style>
