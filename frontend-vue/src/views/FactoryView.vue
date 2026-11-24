<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">厂区管理</h2>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增厂区</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ factories.length }}</div>
        <div class="stat-label">总厂区数</div>
      </div>
      <div class="stat-card stat-active">
        <div class="stat-value">{{ activeCount }}</div>
        <div class="stat-label">启用中</div>
      </div>
      <div class="stat-card stat-inactive">
        <div class="stat-value">{{ cityCount }}</div>
        <div class="stat-label">覆盖城市</div>
      </div>
    </div>

    <div class="filter-bar">
      <el-select v-model="cityFilter" class="filter-select" placeholder="全部城市" clearable>
        <el-option label="全部城市" value="" />
        <el-option v-for="city in cityOptions" :key="city.id" :label="city.city_name" :value="city.id" />
      </el-select>
      <el-select v-model="statusFilter" class="filter-select" placeholder="全部状态" clearable>
        <el-option label="全部状态" value="" />
        <el-option label="启用" value="active" />
        <el-option label="停用" value="inactive" />
      </el-select>
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索厂区名称..."
        clearable
        :prefix-icon="Search"
      />
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="pagedFactories" row-key="id">
        <template #empty>
          <el-empty description="暂无厂区数据" />
        </template>
        <el-table-column prop="factory_name" label="厂区名称" min-width="180">
          <template #default="{ row }">
            <span class="factory-name">{{ row.factory_name }}</span>
          </template>
        </el-table-column>
        <el-table-column label="所属城市" width="120">
          <template #default="{ row }">{{ cityName(row.city_id) }}</template>
        </el-table-column>
        <el-table-column label="地址" min-width="180">
          <template #default="{ row }">
            <span class="muted">{{ row.address || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="联系人" width="130">
          <template #default="{ row }">
            <span class="muted">{{ row.contact || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.is_active ? 'success' : 'info'" effect="light">
              {{ row.is_active ? '启用' : '停用' }}
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
          :total="filteredFactories.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑厂区' : '新增厂区'"
      width="460px"
      :close-on-click-modal="false"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="厂区名称" prop="factory_name">
          <el-input v-model="form.factory_name" placeholder="如：深圳地铁安检基地" />
        </el-form-item>
        <el-form-item label="所属城市" prop="city_id">
          <el-select v-model="form.city_id" class="full" filterable placeholder="请选择城市">
            <el-option v-for="city in cityOptions" :key="city.id" :label="city.city_name" :value="city.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="form.address" placeholder="厂区详细地址" />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="form.contact" placeholder="联系人 / 电话" />
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
import { citiesApi, factoriesApi, apiErrorMessage } from '../api/core'
import type { City, Factory } from '../api/core'
import { formatDateTime, toArray } from '../utils/format'

const factories = ref<Factory[]>([])
const cities = ref<City[]>([])
const loading = ref(false)
const saving = ref(false)
const keyword = ref('')
const cityFilter = ref<number | ''>('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)
const dialogVisible = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

const form = reactive({
  factory_name: '',
  city_id: null as number | null,
  address: '',
  contact: '',
  is_active: true,
})

const rules: FormRules = {
  factory_name: [{ required: true, message: '请输入厂区名称', trigger: 'blur' }],
  city_id: [{ required: true, message: '请选择所属城市', trigger: 'change' }],
}

const cityOptions = computed(() => cities.value)
const activeCount = computed(() => factories.value.filter((item) => item.is_active !== false).length)
const cityCount = computed(() => new Set(factories.value.map((item) => item.city_id).filter(Boolean)).size)

const filteredFactories = computed(() => {
  const key = keyword.value.trim()
  return factories.value.filter((item) => {
    if (cityFilter.value && Number(item.city_id) !== Number(cityFilter.value)) return false
    if (statusFilter.value === 'active' && item.is_active === false) return false
    if (statusFilter.value === 'inactive' && item.is_active !== false) return false
    if (key && !item.factory_name.includes(key)) return false
    return true
  })
})

const pagedFactories = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredFactories.value.slice(start, start + pageSize.value)
})


// 筛选变化时回到第 1 页，避免停在空页
watch([[keyword], [cityFilter], [statusFilter]], () => {
  page.value = 1
})

function cityName(cityId: unknown): string {
  const found = cities.value.find((city) => Number(city.id) === Number(cityId))
  return found?.city_name || '-'
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const [factoryRes, cityRes] = await Promise.all([
      factoriesApi.list({ page: 1, page_size: 1000 }),
      citiesApi.list({ page: 1, page_size: 1000 }).catch(() => ({ data: { items: [] } })),
    ])
    factories.value = toArray<Factory>(factoryRes.data)
    cities.value = toArray<City>((cityRes as { data: unknown }).data)
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '厂区列表加载失败'))
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  editingId.value = null
  form.factory_name = ''
  form.city_id = cityFilter.value ? Number(cityFilter.value) : null
  form.address = ''
  form.contact = ''
  form.is_active = true
  dialogVisible.value = true
}

function openEdit(row: Factory): void {
  editingId.value = row.id
  form.factory_name = row.factory_name
  form.city_id = typeof row.city_id === 'number' ? row.city_id : null
  form.address = String(row.address ?? '')
  form.contact = String(row.contact ?? '')
  form.is_active = row.is_active !== false
  dialogVisible.value = true
}

async function save(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const payload = {
      factory_name: form.factory_name.trim(),
      city_id: form.city_id ?? undefined,
      address: form.address,
      contact: form.contact,
      is_active: form.is_active,
    }
    if (editingId.value) {
      await factoriesApi.update(editingId.value, payload)
      ElMessage.success('厂区已保存')
    } else {
      await factoriesApi.create(payload)
      ElMessage.success('厂区已创建')
    }
    dialogVisible.value = false
    await load()
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '保存失败'))
  } finally {
    saving.value = false
  }
}

async function remove(row: Factory): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除厂区「${row.factory_name}」吗？该操作不可撤销。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await factoriesApi.remove(row.id)
    ElMessage.success('厂区已删除')
    await load()
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '删除失败'))
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

.full {
  width: 100%;
}
</style>
