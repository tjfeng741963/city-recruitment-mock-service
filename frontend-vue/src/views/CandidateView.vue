<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">候选人员管理</h2>
        <p class="page-desc">查看不符合、已邀约、已签到的人员记录</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ stats.total }}</div>
        <div class="stat-label">候选总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.invited }}</div>
        <div class="stat-label">报名成功</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.disqualified }}</div>
        <div class="stat-label">不符合</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.checked_in }}</div>
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
      <el-tooltip content="导出功能待接入" placement="top">
        <span>
          <el-button :icon="Download" disabled>导出 CSV</el-button>
        </span>
      </el-tooltip>
      <span class="count-note">共 <strong>{{ total }}</strong> 条</span>
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
          <el-empty description="暂无候选记录，Agent 对话登记信息后会自动出现在这里" />
        </template>
      </el-table>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { Download, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import http from '../api/http'

/**
 * 2026-11-20：接上 /api/v1/agent/candidates。
 * 该接口由面试登记（agent_archive）聚合而来，之前一直 404，页面是空壳。
 */
interface CandidateRow {
  id: string
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

interface CandidateStats {
  total: number
  invited: number
  disqualified: number
  checked_in: number
}

const loading = ref(false)
const activeTab = ref('invited')
const recruiterFilter = ref('')
const eventDate = ref('')
const interviewDate = ref('')
const rows = ref<CandidateRow[]>([])
const total = ref(0)
const stats = reactive<CandidateStats>({ total: 0, invited: 0, disqualified: 0, checked_in: 0 })
const recruiterOptions = ref<Array<{ label: string; value: string }>>([])
const page = ref(1)
const pageSize = ref(50)

async function load(): Promise<void> {
  loading.value = true
  try {
    const { data } = await http.get<{
      items?: CandidateRow[]
      total?: number
      stats?: CandidateStats
    }>('/api/v1/agent/candidates', {
      params: {
        status: activeTab.value,
        recruiter_id: recruiterFilter.value || undefined,
        event_date: eventDate.value || undefined,
        interview_date: interviewDate.value || undefined,
        page: page.value,
        page_size: pageSize.value,
      },
    })
    rows.value = data.items || []
    total.value = Number(data.total || 0)
    if (data.stats) Object.assign(stats, data.stats)
    const seen = new Set<string>()
    for (const row of rows.value) {
      const value = String(row.recruiter_id || '').trim()
      if (value) seen.add(value)
    }
    for (const option of recruiterOptions.value) seen.add(option.value)
    recruiterOptions.value = [...seen].map((value) => ({ label: value, value }))
  } catch (error: any) {
    rows.value = []
    ElMessage.error(error?.response?.data?.detail || '候选人员加载失败')
  } finally {
    loading.value = false
  }
}

watch([activeTab, recruiterFilter, eventDate, interviewDate], () => {
  page.value = 1
  load()
})

onMounted(load)
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
