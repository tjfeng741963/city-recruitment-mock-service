<template>
  <el-drawer
    :model-value="modelValue"
    :title="`城市配置${recruiterName ? ' · ' + recruiterName : ''}`"
    size="760px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="loadAll"
    @closed="onClosed"
  >
    <el-tabs v-model="activeTab">
      <el-tab-pane label="负责城市" name="cities">
        <div v-loading="loadingCities">
          <div class="toolbar">
            <div class="toolbar-row">
              <span class="toolbar-label">单个添加</span>
              <el-select
                v-model="singleCityId"
                class="city-select"
                filterable
                clearable
                placeholder="选择城市"
              >
                <el-option
                  v-for="city in addableCities"
                  :key="city.id"
                  :label="city.city_name"
                  :value="city.id"
                />
              </el-select>
              <el-button type="primary" :disabled="!singleCityId" :loading="adding" @click="addSingle">
                添加
              </el-button>
            </div>

            <div class="toolbar-row">
              <span class="toolbar-label">批量添加</span>
              <el-select
                v-model="batchCityIds"
                class="city-select"
                multiple
                collapse-tags
                collapse-tags-tooltip
                filterable
                placeholder="选择多个城市"
              >
                <el-option
                  v-for="city in addableCities"
                  :key="city.id"
                  :label="city.city_name"
                  :value="city.id"
                />
              </el-select>
              <el-button :disabled="!batchCityIds.length" :loading="adding" @click="addBatch">
                批量添加
              </el-button>
              <el-link
                type="primary"
                :underline="false"
                class="resync-btn"
                :disabled="!boundCities.length"
                @click="resyncAll"
              >
                {{ resyncing ? '同步中...' : '重新同步绑定' }}
              </el-link>
            </div>
          </div>

          <el-alert
            v-if="citiesError"
            :title="citiesError"
            type="error"
            show-icon
            :closable="false"
            class="drawer-alert"
          />

          <el-table :data="boundCities" size="small" row-key="city_id">
            <template #empty>
              <el-empty description="尚未绑定负责城市，请从上方选择城市添加" :image-size="80" />
            </template>
            <el-table-column prop="city_name" label="城市" min-width="140" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="isEnabled(row) ? 'success' : 'info'" size="small" effect="light">
                  {{ isEnabled(row) ? '启用' : '停用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="排序" width="90">
              <template #default="{ row }">
                <span class="muted">{{ row.sort_order ?? 0 }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="90" align="right">
              <template #default="{ row }">
                <el-button link type="danger" @click="removeBound(row)">移除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-tab-pane>

      <el-tab-pane label="服务城市" name="service">
        <div v-loading="loadingService" class="service-pane">
          <p class="pane-desc">
            服务城市来自 <code>GET /recruiters/:id/service-cities</code>；勾选后保存会调用批量接口新增。
          </p>
          <el-alert
            v-if="serviceError"
            :title="serviceError"
            type="error"
            show-icon
            :closable="false"
            class="drawer-alert"
          />
          <el-transfer
            v-model="serviceSelected"
            :data="transferData"
            :titles="['可选城市', '服务城市']"
            filterable
            filter-placeholder="搜索城市"
            :props="{ key: 'key', label: 'label' }"
          />
          <div class="service-footer">
            <span class="muted">已选择 {{ serviceSelected.length }} 个服务城市</span>
            <el-button type="primary" :loading="savingService" @click="saveServiceCities">
              保存服务城市
            </el-button>
          </div>
          <p class="pane-hint">
            说明：后端暂未提供「取消服务城市」接口，取消勾选不会提交，只提交新增项。
          </p>
        </div>
      </el-tab-pane>
    </el-tabs>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  apiErrorMessage,
  recruitersApi,
  type CityOption,
  type RecruiterCity,
} from '../../api/system'
import { toArray } from '../../utils/format'

const props = defineProps<{
  modelValue: boolean
  recruiterId: number | null
  recruiterName: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'changed'): void
}>()

const activeTab = ref<'cities' | 'service'>('cities')
const loadingCities = ref(false)
const loadingService = ref(false)
const citiesError = ref('')
const serviceError = ref('')
const adding = ref(false)
const resyncing = ref(false)
const savingService = ref(false)

const boundCities = ref<RecruiterCity[]>([])
const allCities = ref<CityOption[]>([])
const singleCityId = ref<number | null>(null)
const batchCityIds = ref<number[]>([])

const serviceCities = ref<RecruiterCity[]>([])
const serviceOptions = ref<CityOption[]>([])
const serviceSelected = ref<string[]>([])
const initialServiceNames = ref<string[]>([])

const boundIds = computed(() => new Set(boundCities.value.map((city) => Number(city.city_id))))
const addableCities = computed(() => allCities.value.filter((city) => !boundIds.value.has(city.id)))

const transferData = computed(() => {
  const names = new Set<string>()
  for (const city of serviceOptions.value) if (city.city_name) names.add(city.city_name)
  for (const city of serviceCities.value) if (city.city_name) names.add(city.city_name)
  return [...names].sort().map((name) => ({ key: name, label: name }))
})

function isEnabled(row: RecruiterCity): boolean {
  return row.is_enabled === undefined ? true : Boolean(row.is_enabled)
}

async function loadCities(): Promise<void> {
  if (!props.recruiterId) return
  loadingCities.value = true
  citiesError.value = ''
  try {
    const [bound, options] = await Promise.all([
      recruitersApi.cities(props.recruiterId),
      recruitersApi.cityOptions(),
    ])
    boundCities.value = toArray<RecruiterCity>(bound.data)
    allCities.value = toArray<CityOption>(options.data)
  } catch (error) {
    citiesError.value = apiErrorMessage(error, '负责城市加载失败')
  } finally {
    loadingCities.value = false
  }
}

async function loadServiceCities(): Promise<void> {
  if (!props.recruiterId) return
  loadingService.value = true
  serviceError.value = ''
  try {
    const [current, options] = await Promise.all([
      recruitersApi.serviceCities(props.recruiterId),
      recruitersApi.serviceCityOptions(props.recruiterId),
    ])
    serviceCities.value = toArray<RecruiterCity>(current.data)
    serviceOptions.value = toArray<CityOption>(options.data)
    const names = serviceCities.value.map((city) => city.city_name).filter(Boolean)
    initialServiceNames.value = [...names]
    serviceSelected.value = [...names]
  } catch (error) {
    serviceError.value = apiErrorMessage(error, '服务城市加载失败')
  } finally {
    loadingService.value = false
  }
}

function loadAll(): void {
  singleCityId.value = null
  batchCityIds.value = []
  void loadCities()
  void loadServiceCities()
}

function onClosed(): void {
  boundCities.value = []
  allCities.value = []
  serviceCities.value = []
  serviceOptions.value = []
  serviceSelected.value = []
  citiesError.value = ''
  serviceError.value = ''
}

async function addSingle(): Promise<void> {
  if (!props.recruiterId || !singleCityId.value) return
  adding.value = true
  try {
    await recruitersApi.addCity(props.recruiterId, singleCityId.value)
    ElMessage.success('负责城市已添加')
    singleCityId.value = null
    await loadCities()
    emit('changed')
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '添加失败'))
  } finally {
    adding.value = false
  }
}

async function addBatch(): Promise<void> {
  if (!props.recruiterId || !batchCityIds.value.length) return
  adding.value = true
  try {
    const { data } = await recruitersApi.addCities(props.recruiterId, batchCityIds.value)
    ElMessage.success(`已添加 ${Number(data.added ?? batchCityIds.value.length)} 个负责城市`)
    batchCityIds.value = []
    await loadCities()
    emit('changed')
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '批量添加失败'))
  } finally {
    adding.value = false
  }
}

async function removeBound(row: RecruiterCity): Promise<void> {
  if (!props.recruiterId) return
  try {
    await ElMessageBox.confirm(`确定移除负责城市「${row.city_name}」吗？`, '移除确认', {
      type: 'warning',
      confirmButtonText: '移除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await recruitersApi.removeCity(props.recruiterId, row.city_id)
    ElMessage.success('负责城市已移除')
    await loadCities()
    emit('changed')
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '移除失败'))
  }
}

/** PUT /cities/:cityId 会把绑定重新写入（幂等），用于修复异常绑定数据 */
async function resyncAll(): Promise<void> {
  if (!props.recruiterId || !boundCities.value.length) return
  resyncing.value = true
  try {
    await Promise.all(
      boundCities.value.map((city) => recruitersApi.syncCity(props.recruiterId!, city.city_id)),
    )
    ElMessage.success('负责城市绑定已重新同步')
    await loadCities()
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '同步失败'))
  } finally {
    resyncing.value = false
  }
}

async function saveServiceCities(): Promise<void> {
  if (!props.recruiterId) return
  const added = serviceSelected.value.filter((name) => !initialServiceNames.value.includes(name))
  const removed = initialServiceNames.value.filter((name) => !serviceSelected.value.includes(name))

  if (!added.length && !removed.length) {
    ElMessage.info('服务城市没有变化')
    return
  }

  savingService.value = true
  try {
    if (added.length) {
      const { data } = await recruitersApi.batchServiceCities(props.recruiterId, added, true)
      ElMessage.success(`已新增 ${Number(data.added ?? added.length)} 个服务城市`)
    }
    if (removed.length) {
      ElMessage.warning(`后端未提供取消服务城市接口，${removed.length} 个取消操作未提交`)
    }
    await loadServiceCities()
    emit('changed')
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '服务城市保存失败'))
  } finally {
    savingService.value = false
  }
}
</script>

<style scoped>
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
}

.toolbar-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.toolbar-label {
  width: 64px;
  color: var(--bd-text-tertiary);
  font-size: 12.5px;
}

.city-select {
  width: 240px;
}

.resync-btn {
  margin-left: auto;
  font-size: 12.5px;
}

.drawer-alert {
  margin-bottom: 12px;
}

.service-pane {
  padding-bottom: 8px;
}

.pane-desc {
  margin: 0 0 12px;
  color: var(--bd-text-tertiary);
  font-size: 13px;
}

.pane-hint {
  margin-top: 10px;
  color: var(--bd-text-tertiary);
  font-size: 12px;
}

.service-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 18px;
}

:deep(.el-transfer) {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

:deep(.el-transfer-panel) {
  width: 260px;
}
</style>
