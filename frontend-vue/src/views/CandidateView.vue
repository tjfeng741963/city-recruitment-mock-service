<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">候选人员管理</h2>
        <p class="page-desc">查看不符合、已邀约、已签到的人员记录</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :loading="loading" @click="loadDevices">刷新招聘经理</el-button>
      </div>
    </div>

    <el-alert
      class="degrade-alert"
      type="warning"
      show-icon
      :closable="false"
      title="后端未提供 /api/v1/agent/candidates，页面结构已就绪"
      description="该接口当前返回 404，页面保留旧版统计卡、招聘经理筛选、导出与 13 列表头，不展示任何伪造数据。接口恢复后即可直接接入。"
    />

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value muted-value">—</div>
        <div class="stat-label">候选总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value muted-value">—</div>
        <div class="stat-label">报名成功</div>
      </div>
      <div class="stat-card">
        <div class="stat-value muted-value">—</div>
        <div class="stat-label">不符合</div>
      </div>
      <div class="stat-card">
        <div class="stat-value muted-value">—</div>
        <div class="stat-label">已签到</div>
      </div>
    </div>

    <el-tabs v-model="activeTab" class="candidate-tabs">
      <el-tab-pane label="报名成功" name="invited" />
      <el-tab-pane label="不符合" name="disqualified" />
      <el-tab-pane label="已签到" name="checked_in" />
    </el-tabs>

    <div class="filter-bar">
      <el-select
        v-model="recruiterFilter"
        class="recruiter-select"
        placeholder="选择招聘经理"
        clearable
      >
        <el-option v-for="item in recruiterOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-date-picker
        v-model="eventDate"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="筛选事件日期"
        class="date-select"
      />
      <el-date-picker
        v-if="activeTab === 'invited'"
        v-model="interviewDate"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="筛选面试日期"
        class="date-select"
      />
      <el-tooltip content="接口返回 404，暂无可导出数据" placement="top">
        <span>
          <el-button :icon="Download" disabled>导出 CSV</el-button>
        </span>
      </el-tooltip>
      <span class="count-note">共 <strong>0</strong> 条</span>
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="rows" row-key="id">
        <el-table-column prop="device_name" label="设备" min-width="140" />
        <el-table-column prop="recruiter_id" label="归属账号" width="120" />
        <el-table-column prop="nickname" label="昵称" width="110" />
        <el-table-column prop="name" label="姓名" width="90" />
        <el-table-column prop="phone" label="电话" width="130" />
        <el-table-column prop="event_at" label="事件时间" width="165" />
        <el-table-column prop="interview_date" label="面试日期" width="110" />
        <el-table-column prop="factory_name" label="面试工厂" min-width="140" />
        <el-table-column prop="interview_time" label="面试时间" width="100" />
        <el-table-column prop="city" label="省市区" width="110" />
        <el-table-column prop="summary" label="登记摘要" min-width="200" />
        <el-table-column prop="created_at" label="记录时间" width="165" />
        <el-table-column label="操作" width="100" fixed="right">
          <template #default>
            <span class="muted">-</span>
          </template>
        </el-table-column>

        <template #empty>
          <el-empty description="后端未提供 /api/v1/agent/candidates，页面结构已就绪" />
        </template>
      </el-table>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Download, Refresh } from '@element-plus/icons-vue'
import { devicesApi, type AgentDeviceItem } from '../api/agent'

/**
 * 后端 /api/v1/agent/candidates 明确 404：
 * 这里只保留旧版页面结构，不发起请求、不展示伪造数据。
 */
interface CandidateRow {
  id: number | string
  device_name: string
  recruiter_id: string
  nickname: string
  name: string
  phone: string
  event_at: string
  interview_date: string
  factory_name: string
  interview_time: string
  city: string
  summary: string
  created_at: string
}

const loading = ref(false)
const devices = ref<AgentDeviceItem[]>([])
const activeTab = ref('invited')
const recruiterFilter = ref('')
const eventDate = ref('')
const interviewDate = ref('')
const rows = ref<CandidateRow[]>([])

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

.candidate-tabs {
  margin-bottom: 4px;
}

.recruiter-select {
  width: 240px;
}

.date-select {
  width: 170px;
}

.count-note {
  margin-left: 4px;
  font-size: 13px;
  color: var(--bd-text-tertiary);
}
</style>
