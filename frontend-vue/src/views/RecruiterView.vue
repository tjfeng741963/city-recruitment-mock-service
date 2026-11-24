<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">招聘员管理</h2>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">添加招聘员</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ recruiters.length }}</div>
        <div class="stat-label">总招聘员</div>
      </div>
      <div class="stat-card stat-active">
        <div class="stat-value">{{ activeCount }}</div>
        <div class="stat-label">已启用</div>
      </div>
    </div>

    <div class="filter-bar">
      <el-input
        v-model="keywordId"
        class="search-input"
        placeholder="搜索招聘员ID..."
        clearable
        :prefix-icon="Search"
      />
      <el-input
        v-model="keywordName"
        class="search-input"
        placeholder="搜索姓名..."
        clearable
        :prefix-icon="Search"
      />
      <el-select v-model="statusFilter" class="status-select" placeholder="状态筛选" clearable>
        <el-option label="全部状态" value="" />
        <el-option label="启用" value="active" />
        <el-option label="停用" value="inactive" />
      </el-select>
    </div>

    <el-alert
      v-if="errorMessage"
      :title="errorMessage"
      type="error"
      show-icon
      :closable="false"
      class="list-alert"
    >
      <template #default>
        <el-button link type="primary" @click="load">重新加载</el-button>
      </template>
    </el-alert>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="pagedRecruiters" row-key="id">
        <template #empty>
          <el-empty description="暂无招聘员，点击右上角「添加招聘员」开始配置" />
        </template>
        <el-table-column prop="recruiter_id" label="招聘员ID" min-width="130" />
        <el-table-column prop="name" label="姓名" min-width="100" />
        <el-table-column label="描述" min-width="110">
          <template #default="{ row }">
            <span class="muted">{{ row.description || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="96">
          <template #default="{ row }">
            <el-tag type="warning" effect="plain" size="small">
              {{ recruiterTypeLabel(row.recruiter_type) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="城市数" width="70" align="center">
          <template #default="{ row }">
            <span>{{ row.city_count ?? 0 }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-switch
              :model-value="row.is_active !== false"
              inline-prompt
              active-text="启用"
              inactive-text="停用"
              :loading="switchingId === row.id"
              @change="(value: string | number | boolean) => toggleActive(row, value)"
            />
          </template>
        </el-table-column>
        <el-table-column label="登录密码" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.password_set ? 'success' : 'info'" size="small" effect="light">
              {{ row.password_set ? '已设置' : '未设置' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="排序" width="70" align="center">
          <template #default="{ row }">
            <span class="muted">{{ row.sort_order ?? 0 }}</span>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="140">
          <template #default="{ row }">
            <span class="muted">{{ formatDateTime(row.updated_at) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="primary" @click="openCities(row)">城市</el-button>
            <el-button link type="primary" @click="openPassword(row)">密码</el-button>
            <el-button link type="danger" @click="removeRecruiter(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="filteredRecruiters.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </div>

    <RecruiterFormDialog
      v-model="formVisible"
      :mode="formMode"
      :recruiter-id="activeId"
      @saved="load"
    />
    <RecruiterCitiesDrawer
      v-model="citiesVisible"
      :recruiter-id="activeId"
      :recruiter-name="activeName"
      @changed="load"
    />
    <RecruiterPasswordDialog
      v-model="passwordVisible"
      :recruiter-id="activeId"
      :recruiter-name="activeName"
      @saved="load"
    />
  </section>
</template>

<script setup lang="ts">
import {  computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  apiErrorMessage,
  recruiterTypeLabel,
  recruitersApi,
} from '../api/system'
import type { Recruiter } from '../api/types'
import { formatDateTime, toArray } from '../utils/format'
import RecruiterFormDialog from '../components/system/RecruiterFormDialog.vue'
import RecruiterCitiesDrawer from '../components/system/RecruiterCitiesDrawer.vue'
import RecruiterPasswordDialog from '../components/system/RecruiterPasswordDialog.vue'

const recruiters = ref<Recruiter[]>([])
const loading = ref(false)
const errorMessage = ref('')
const keywordId = ref('')
const keywordName = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)
const switchingId = ref<number | null>(null)

const formVisible = ref(false)
const citiesVisible = ref(false)
const passwordVisible = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const activeId = ref<number | null>(null)
const activeName = ref('')

const activeCount = computed(() => recruiters.value.filter((item) => item.is_active !== false).length)

const filteredRecruiters = computed(() => {
  const idKey = keywordId.value.trim().toLowerCase()
  const nameKey = keywordName.value.trim().toLowerCase()
  return recruiters.value.filter((item) => {
    const active = item.is_active !== false
    if (statusFilter.value === 'active' && !active) return false
    if (statusFilter.value === 'inactive' && active) return false
    if (idKey && !String(item.recruiter_id || '').toLowerCase().includes(idKey)) return false
    if (nameKey && !String(item.name || '').toLowerCase().includes(nameKey)) return false
    return true
  })
})

const pagedRecruiters = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredRecruiters.value.slice(start, start + pageSize.value)
})


// 筛选变化时回到第 1 页，避免停在空页
watch([[statusFilter]], () => {
  page.value = 1
})

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const { data } = await recruitersApi.list({ page: 1, page_size: 1000 })
    recruiters.value = toArray<Recruiter>(data)
  } catch (error) {
    errorMessage.value = apiErrorMessage(error, '招聘员列表加载失败')
    recruiters.value = []
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  formMode.value = 'create'
  activeId.value = null
  formVisible.value = true
}

function openEdit(row: Recruiter): void {
  formMode.value = 'edit'
  activeId.value = row.id
  formVisible.value = true
}

function openCities(row: Recruiter): void {
  activeId.value = row.id
  activeName.value = row.name
  citiesVisible.value = true
}

function openPassword(row: Recruiter): void {
  activeId.value = row.id
  activeName.value = row.name
  passwordVisible.value = true
}

async function toggleActive(row: Recruiter, value: string | number | boolean): Promise<void> {
  switchingId.value = row.id
  try {
    await recruitersApi.update(row.id, { is_active: Boolean(value) })
    ElMessage.success(value ? '招聘员已启用' : '招聘员已停用')
    await load()
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '状态切换失败'))
  } finally {
    switchingId.value = null
  }
}

async function removeRecruiter(row: Recruiter): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除招聘员「${row.name}」（${row.recruiter_id}）吗？其绑定的城市与账号关联将一并失效。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await recruitersApi.remove(row.id)
    ElMessage.success('招聘员已删除')
    await load()
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '删除失败'))
  }
}

onMounted(load)
</script>

<style scoped>
.search-input {
  width: 220px;
}

.status-select {
  width: 150px;
}

.list-alert {
  margin-bottom: 12px;
}

.table-wrapper :deep(.el-switch.is-checked .el-switch__core) {
  background-color: #12a150 !important;
  border-color: #12a150 !important;
}
</style>
