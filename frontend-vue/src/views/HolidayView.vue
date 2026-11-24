<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">节假日管理</h2>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增节假日</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ items.length }}</div>
        <div class="stat-label">节假日总数</div>
      </div>
      <div class="stat-card stat-active">
        <div class="stat-value">{{ activeCount }}</div>
        <div class="stat-label">启用中</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ cityOptions.length }}</div>
        <div class="stat-label">覆盖城市</div>
      </div>
    </div>

    <div class="filter-bar">
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
        placeholder="搜索节日名称..."
        clearable
        :prefix-icon="Search"
      />
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="pagedItems" row-key="id">
        <template #empty>
          <el-empty description="暂无节假日安排，点击右上角「新增节假日」开始配置" />
        </template>
        <el-table-column label="节日名称" min-width="140">
          <template #default="{ row }">
            <span class="holiday-name">{{ row.holiday_name || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="城市" width="120">
          <template #default="{ row }">{{ row.city_name || cityNameOf(row.city_id) }}</template>
        </el-table-column>
        <el-table-column label="年份" width="90" align="center">
          <template #default="{ row }">{{ row.year || '-' }}</template>
        </el-table-column>
        <el-table-column label="开始日期" width="130">
          <template #default="{ row }">
            <span class="muted">{{ row.start_date || row.date || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结束日期" width="130">
          <template #default="{ row }">
            <span class="muted">{{ row.end_date || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="isActive(row) ? 'success' : 'info'" effect="light">
              {{ isActive(row) ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">
            <span class="muted">{{ formatDateTime(row.updated_at) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
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

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑节假日' : '新增节假日'"
      width="480px"
      :close-on-click-modal="false"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="节日名称" prop="holiday_name">
          <el-input v-model="form.holiday_name" placeholder="如：春节" />
        </el-form-item>
        <el-form-item label="所属城市" prop="city_name">
          <el-select v-model="form.city_name" class="full" filterable placeholder="请选择城市">
            <el-option v-for="city in cityOptions" :key="city" :label="city" :value="city" />
          </el-select>
        </el-form-item>
        <el-form-item label="年份">
          <el-input-number v-model="form.year" :min="2000" :max="2100" class="full" />
        </el-form-item>
        <el-form-item label="开始日期" prop="start_date">
          <el-date-picker
            v-model="form.start_date"
            type="date"
            class="full"
            value-format="YYYY-MM-DD"
            placeholder="选择开始日期"
            title="面试安排会避开启用的假期"
          />
        </el-form-item>
        <el-form-item label="结束日期" prop="end_date">
          <el-date-picker
            v-model="form.end_date"
            type="date"
            class="full"
            value-format="YYYY-MM-DD"
            placeholder="选择结束日期"
          />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="form.is_active" active-text="启用" inactive-text="停用" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import {  computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import { citiesApi, holidaysApi, apiErrorMessage } from '../api/core'
import type { City, HolidaySchedule } from '../api/core'
import { formatDateTime, toArray } from '../utils/format'

interface HolidayRow extends HolidaySchedule {
  city_name?: string
}

const items = ref<HolidayRow[]>([])
const myCities = ref<Array<{ city_name: string }>>([])
const cities = ref<City[]>([])
const loading = ref(false)
const saving = ref(false)
const keyword = ref('')
const cityFilter = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)
const dialogVisible = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

const form = reactive({
  holiday_name: '',
  city_name: '',
  year: new Date().getFullYear(),
  start_date: '',
  end_date: '',
  is_active: true,
})

const rules: FormRules = {
  holiday_name: [{ required: true, message: '请输入节日名称', trigger: 'blur' }],
  city_name: [{ required: true, message: '请选择所属城市', trigger: 'change' }],
  start_date: [{ required: true, message: '请选择开始日期', trigger: 'change' }],
}

const cityOptions = computed(() => myCities.value.map((city) => city.city_name).filter(Boolean))
const activeCount = computed(() => items.value.filter((item) => isActive(item)).length)

const filteredItems = computed(() => {
  const key = keyword.value.trim()
  return items.value.filter((item) => {
    const city = item.city_name || cityNameOf(item.city_id)
    if (cityFilter.value && city !== cityFilter.value) return false
    if (statusFilter.value === 'active' && !isActive(item)) return false
    if (statusFilter.value === 'inactive' && isActive(item)) return false
    if (key && !String(item.holiday_name ?? '').includes(key)) return false
    return true
  })
})

const pagedItems = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredItems.value.slice(start, start + pageSize.value)
})


// 筛选变化时回到第 1 页，避免停在空页
watch([[keyword], [cityFilter], [statusFilter]], () => {
  page.value = 1
})

function cityNameOf(cityId: unknown): string {
  const found = cities.value.find((city) => Number(city.id) === Number(cityId))
  return found?.city_name || ''
}

function isActive(row: HolidaySchedule): boolean {
  if (typeof row.is_active === 'boolean') return row.is_active
  if (typeof row.status === 'string') return row.status === 'enabled'
  return true
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const [listRes, cityRes, allCityRes] = await Promise.all([
      holidaysApi.list({ page: 1, page_size: 1000 }),
      holidaysApi.myCities().catch(() => ({ data: { cities: [] } })),
      citiesApi.list({ page: 1, page_size: 1000 }).catch(() => ({ data: { items: [] } })),
    ])
    items.value = (listRes.data.items || []) as HolidayRow[]
    myCities.value = cityRes.data.cities || []
    cities.value = toArray<City>((allCityRes as { data: unknown }).data)
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '节假日列表加载失败'))
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  editingId.value = null
  form.holiday_name = ''
  form.city_name = cityFilter.value || cityOptions.value[0] || ''
  form.year = new Date().getFullYear()
  form.start_date = ''
  form.end_date = ''
  form.is_active = true
  dialogVisible.value = true
}

function openEdit(row: HolidayRow): void {
  editingId.value = row.id
  form.holiday_name = String(row.holiday_name ?? '')
  form.city_name = row.city_name || cityNameOf(row.city_id)
  form.year = Number(row.year ?? new Date().getFullYear())
  form.start_date = String(row.start_date || row.date || '')
  form.end_date = String(row.end_date ?? '')
  form.is_active = isActive(row)
  dialogVisible.value = true
}

async function save(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const payload = {
      city_name: form.city_name,
      // 年份跟随开始日期，避免用户在日期面板跨年后年份不一致
      year: Number(form.start_date.slice(0, 4)) || form.year,
      holiday_name: form.holiday_name.trim(),
      start_date: form.start_date,
      end_date: form.end_date || form.start_date,
      is_active: form.is_active,
    }
    if (editingId.value) {
      await holidaysApi.update(editingId.value, payload)
      ElMessage.success('节假日已保存')
    } else {
      await holidaysApi.create(payload)
      ElMessage.success('节假日已创建')
    }
    dialogVisible.value = false
    await load()
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '保存失败'))
  } finally {
    saving.value = false
  }
}

async function remove(row: HolidayRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除节假日「${row.holiday_name || row.start_date}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await holidaysApi.remove(row.id)
    ElMessage.success('节假日已删除')
    await load()
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '删除失败'))
  }
}

onMounted(load)
</script>

<style scoped>
.holiday-name {
  font-weight: 600;
  color: var(--bd-text-primary);
}

.filter-select {
  width: 150px;
}

.search-input {
  width: 260px;
}

.full {
  width: 100%;
}
</style>
