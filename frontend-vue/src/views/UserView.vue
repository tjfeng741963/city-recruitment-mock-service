<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">用户管理</h2>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">添加用户</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ users.length }}</div>
        <div class="stat-label">总用户</div>
      </div>
      <div class="stat-card stat-active">
        <div class="stat-value">{{ adminCount }}</div>
        <div class="stat-label">管理员</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ customerCount }}</div>
        <div class="stat-label">客户</div>
      </div>
    </div>

    <div class="filter-bar">
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索用户名..."
        clearable
        :prefix-icon="Search"
      />
      <el-select v-model="roleFilter" class="status-select" placeholder="角色筛选" clearable>
        <el-option label="全部角色" value="" />
        <el-option v-for="item in userRoles" :key="item.value" :label="item.label" :value="item.value" />
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
      <el-table v-loading="loading" :data="pagedUsers" row-key="id">
        <template #empty>
          <el-empty description="暂无用户，点击右上角「添加用户」创建账号" />
        </template>
        <el-table-column prop="username" label="用户名" min-width="160">
          <template #default="{ row }">
            <span class="username">{{ row.username }}</span>
            <el-tag v-if="row.username === currentUsername" size="small" type="info" effect="plain">
              当前登录
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="110">
          <template #default="{ row }">
            <el-tag :type="roleTagType(row.role)" size="small" effect="light">
              {{ roleLabel(row.role) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="招聘员ID" min-width="150">
          <template #default="{ row }">
            <span class="muted">{{ row.recruiter_id || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="180">
          <template #default="{ row }">
            <span class="muted">{{ formatDateTime(row.created_at) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="primary" @click="openScopes(row)">权限</el-button>
            <el-button link type="primary" @click="openReset(row)">重置密码</el-button>
            <el-tooltip
              :disabled="row.username !== currentUsername"
              content="不能删除当前登录账号"
              placement="top"
            >
              <span>
                <el-button
                  link
                  type="danger"
                  :disabled="row.username === currentUsername"
                  @click="removeUser(row)"
                >
                  删除
                </el-button>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="filteredUsers.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </div>

    <UserFormDialog
      v-model="formVisible"
      :mode="formMode"
      :user="activeUser"
      :recruiters="recruiters"
      :current-username="currentUsername"
      @saved="load"
    />
    <UserScopesDrawer
      v-model="scopesVisible"
      :user="activeUser"
      :recruiters="recruiters"
      @saved="load"
    />
    <ResetPasswordDialog v-model="resetVisible" :user="activeUser" />
  </section>
</template>

<script setup lang="ts">
import {  computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import {
  apiErrorMessage,
  roleLabel,
  roleTagType,
  userRoles,
  usersApi,
  type UserItem,
} from '../api/system'
import { recruitersApi } from '../api/system'
import { useAuthStore } from '../stores/auth'
import type { Recruiter } from '../api/types'
import { formatDateTime, toArray } from '../utils/format'
import UserFormDialog from '../components/system/UserFormDialog.vue'
import UserScopesDrawer from '../components/system/UserScopesDrawer.vue'
import ResetPasswordDialog from '../components/system/ResetPasswordDialog.vue'

const auth = useAuthStore()
const currentUsername = computed(() => auth.user?.username || 'local-admin')

const users = ref<UserItem[]>([])
const recruiters = ref<Recruiter[]>([])
const loading = ref(false)
const errorMessage = ref('')
const keyword = ref('')
const roleFilter = ref('')
const page = ref(1)
const pageSize = ref(20)

const formVisible = ref(false)
const scopesVisible = ref(false)
const resetVisible = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const activeUser = ref<UserItem | null>(null)

const adminCount = computed(() => users.value.filter((item) => item.role === 'admin').length)
const customerCount = computed(() => users.value.filter((item) => item.role === 'customer').length)

const filteredUsers = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return users.value.filter((item) => {
    if (roleFilter.value && item.role !== roleFilter.value) return false
    if (key && !item.username.toLowerCase().includes(key)) return false
    return true
  })
})

const pagedUsers = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredUsers.value.slice(start, start + pageSize.value)
})


// 筛选变化时回到第 1 页，避免停在空页
watch([[keyword], [roleFilter]], () => {
  page.value = 1
})

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const [userResult, recruiterResult] = await Promise.all([
      usersApi.list({ page: 1, page_size: 1000, is_active: true }),
      recruitersApi.list({ page: 1, page_size: 1000 }),
    ])
    users.value = toArray<UserItem>(userResult.data)
    recruiters.value = toArray<Recruiter>(recruiterResult.data)
  } catch (error) {
    errorMessage.value = apiErrorMessage(error, '用户列表加载失败')
    users.value = []
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  formMode.value = 'create'
  activeUser.value = null
  formVisible.value = true
}

function openEdit(row: UserItem): void {
  formMode.value = 'edit'
  activeUser.value = row
  formVisible.value = true
}

function openScopes(row: UserItem): void {
  activeUser.value = row
  scopesVisible.value = true
}

function openReset(row: UserItem): void {
  activeUser.value = row
  resetVisible.value = true
}

async function removeUser(row: UserItem): Promise<void> {
  if (row.username === currentUsername.value) {
    ElMessage.warning('不能删除当前登录账号')
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定删除用户「${row.username}」吗？账号将被停用并从列表隐藏，用户名会保留且不能重复注册。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await usersApi.remove(row.id)
    ElMessage.success('用户已删除')
    await load()
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '删除失败'))
  }
}

onMounted(load)
</script>

<style scoped>
.search-input {
  width: 260px;
}

.status-select {
  width: 150px;
}

.list-alert {
  margin-bottom: 12px;
}

.username {
  font-weight: 600;
  color: var(--bd-text-primary);
  margin-right: 6px;
}
</style>
