<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">老友管理</h2>
        <p class="page-desc">企微端上报的老客户，AI 不自动回复，可手动放行</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :loading="loading" @click="loadDevices">刷新设备</el-button>
      </div>
    </div>

    <el-alert
      class="degrade-alert"
      type="warning"
      show-icon
      :closable="false"
      title="后端未提供 /api/v1/agent/old-friends，页面结构已就绪"
      description="该接口当前返回 404。统计卡、筛选、表头与操作列均按旧版保留，设备筛选使用 /api/v1/agent/devices 的真实数据，不展示伪造记录。"
    />

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value muted-value">—</div>
        <div class="stat-label">总老友</div>
      </div>
      <div class="stat-card">
        <div class="stat-value muted-value">—</div>
        <div class="stat-label">不可聊</div>
      </div>
      <div class="stat-card">
        <div class="stat-value muted-value">—</div>
        <div class="stat-label">可聊</div>
      </div>
    </div>

    <div class="filter-bar">
      <el-select v-model="statusFilter" class="status-select" placeholder="状态筛选" clearable>
        <el-option label="全部状态" value="" />
        <el-option label="可聊" value="release" />
        <el-option label="不可聊" value="blocked" />
      </el-select>
      <el-select v-model="recruiterFilter" class="status-select" placeholder="招聘员筛选" clearable>
        <el-option v-for="item in recruiterOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="deviceFilter" class="device-select" placeholder="设备筛选" clearable>
        <el-option label="全部设备" value="" />
        <el-option
          v-for="device in devices"
          :key="device.id"
          :label="`${device.name || device.device_code}（${device.device_code}）`"
          :value="device.device_code"
        />
      </el-select>
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索昵称或客户ID..."
        clearable
        :prefix-icon="Search"
      />
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="rows" row-key="id">
        <el-table-column prop="nickname" label="昵称" min-width="140" />
        <el-table-column prop="customer_id" label="客户 ID" width="140" />
        <el-table-column prop="device_code" label="设备" min-width="160" />
        <el-table-column prop="recruiter_id" label="招聘员" width="130" />
        <el-table-column prop="status" label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 'release' ? 'success' : 'info'" size="small" effect="light">
              {{ row.status === 'release' ? '可聊' : '不可聊' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="180" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary">{{ row.status === 'release' ? '设为不可聊' : '放行' }}</el-button>
          </template>
        </el-table-column>

        <template #empty>
          <div class="empty-block">
            <el-empty description="后端未提供 /api/v1/agent/old-friends，页面结构已就绪" />
            <p class="empty-hint">接口恢复后，这里会显示企微上报的老友记录。</p>
          </div>
        </template>
      </el-table>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Refresh, Search } from '@element-plus/icons-vue'
import { devicesApi, type AgentDeviceItem } from '../api/agent'

/**
 * 后端 /api/v1/agent/old-friends 明确 404：
 * 保留旧版结构，仅复用真实设备列表做筛选选项。
 */
interface OldFriendRow {
  id: number | string
  nickname: string
  customer_id: string
  device_code: string
  recruiter_id: string
  status: string
  created_at: string
}

const loading = ref(false)
const devices = ref<AgentDeviceItem[]>([])
const statusFilter = ref('')
const recruiterFilter = ref('')
const deviceFilter = ref('')
const keyword = ref('')
const rows = ref<OldFriendRow[]>([])

const recruiterOptions = computed(() => {
  const seen = new Set<string>()
  const options: Array<{ label: string; value: string }> = []
  for (const device of devices.value) {
    const value = String(device.recruiter_id || '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    options.push({ label: value, value })
  }
  return options
})

async function loadDevices(): Promise<void> {
  loading.value = true
  try {
    const { data } = await devicesApi.list({ page: 1, page_size: 1000 })
    devices.value = data.items || []
  } catch {
    devices.value = []
  } finally {
    loading.value = false
  }
}

onMounted(loadDevices)
</script>

<style scoped>
.degrade-alert {
  margin-bottom: 16px;
}

.muted-value {
  color: var(--bd-text-tertiary);
}

.status-select {
  width: 150px;
}

.device-select {
  width: 230px;
}

.search-input {
  width: 260px;
}

.empty-block {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.empty-hint {
  margin: -6px 0 12px;
  color: var(--bd-text-tertiary);
  font-size: 12px;
}
</style>
