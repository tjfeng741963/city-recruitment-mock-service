<template>
  <section class="dashboard">
    <div class="page-header">
      <div>
        <h2 class="page-title">{{ pageTitle }}</h2>
      </div>
      <div class="header-actions">
        <span class="refresh-hint" title="每 3 分钟自动刷新">{{ lastRefreshText }}</span>
        <el-button :loading="loading" @click="refresh()">刷新</el-button>
      </div>
    </div>

    <section class="admin-overview">
      <h3 class="overview-title">后台运营总览</h3>
      <div class="admin-overview-grid">
        <div v-for="item in overviewItems" :key="item.label" class="admin-overview-card">
          <div class="admin-overview-value">{{ item.value }}</div>
          <div class="admin-overview-label">{{ item.label }}</div>
        </div>
      </div>
    </section>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ deviceTotal }}</div>
        <div class="stat-label">设备总数</div>
        <div class="stat-sub">{{ deviceActiveToday }} 今日活跃</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ messageTotal }}</div>
        <div class="stat-label">今日消息</div>
      </div>
      <div class="stat-card" :class="{ 'stat-warn': queuePending > 10 }">
        <div class="stat-value">{{ queuePending }}</div>
        <div class="stat-label">排队堆积</div>
        <div v-if="queuePending > 10" class="stat-sub">⚠️ 待处理</div>
      </div>
      <div class="stat-card" :class="{ 'stat-danger': difyFailed > 0 }">
        <div class="stat-value">{{ difyFailed }}</div>
        <div class="stat-label">Dify 失败</div>
      </div>
      <div class="stat-card" :class="{ 'stat-danger': aiAbnormal > 0 }">
        <div class="stat-value">{{ aiAbnormal }}</div>
        <div class="stat-label">AI 异常</div>
      </div>
    </div>

    <ChartCard title="本月每日趋势" class="trend-card">
      <div v-if="dailyTrend.length" class="daily-chart">
        <div v-for="point in dailyTrend" :key="point.date" class="daily-col">
          <div class="daily-bar-group">
            <div
              class="daily-bar daily-total"
              :style="{ height: dailyBarHeight(point.total) + 'px' }"
              :title="`${point.date} 人数: ${point.total}`"
            />
            <div
              class="daily-bar daily-invited"
              :style="{ height: dailyBarHeight(point.invited) + 'px' }"
              :title="`${point.date} 邀约: ${point.invited}`"
            />
          </div>
          <div class="daily-total-num">{{ point.total }}</div>
          <div class="daily-label">{{ shortDay(point.date) }}日</div>
          <div class="daily-rate">{{ point.rate }}%</div>
        </div>
      </div>
      <div v-else class="chart-empty">
        <el-empty description="暂无数据" :image-size="40" />
      </div>
      <div class="daily-legend">
        <span><span class="legend-dot" style="background: #409eff" />总人数</span>
        <span><span class="legend-dot" style="background: #67c23a" />邀约数</span>
        <span class="legend-rate">数字 = 邀约率</span>
      </div>
    </ChartCard>

    <div class="chart-row">
      <ChartCard title="今日消息趋势" :subtitle="`共 ${messageTotal} 条`" class="message-card">
        <div v-if="hourlyMessages.length" class="bar-chart">
          <div v-for="point in hourlyMessages" :key="point.hour" class="bar-item">
            <div
              class="bar"
              :style="{ height: hourlyBarHeight(point.count) + 'px' }"
              :title="`${point.hour}时: ${point.count}条`"
            />
            <div class="bar-label">{{ point.hour }}</div>
          </div>
        </div>
        <div v-else class="chart-empty">
          <el-empty description="暂无数据" :image-size="40" />
        </div>
      </ChartCard>

      <ChartCard title="对话状态分布" class="state-card">
        <div v-if="stateEntries.length" class="state-list">
          <div v-for="[key, value] in stateEntries" :key="key" class="state-row">
            <span class="state-name">{{ stateLabel(key) }}</span>
            <div class="state-bar-bg">
              <div class="state-bar" :style="{ width: statePercent(value) + '%' }" />
            </div>
            <span class="state-cnt">{{ value }}</span>
          </div>
        </div>
        <div v-else class="chart-empty">
          <el-empty description="暂无数据" :image-size="40" />
        </div>
      </ChartCard>
    </div>

    <el-alert
      v-if="degradedDevices.length"
      class="degraded-alert"
      type="warning"
      title="服务降级设备"
      :closable="false"
      show-icon
    >
      <div v-for="item in degradedDevices" :key="item.device_code" class="degraded-line">
        {{ item.device_code }} — Dify 失败率 {{ item.fail_rate }}%
      </div>
    </el-alert>

    <div class="chart-row">
      <ChartCard title="Dify 健康度 (今日失败 Top)">
        <el-table :data="difyHealth" size="small" style="width: 100%">
          <el-table-column prop="device_code" label="设备" min-width="160" />
          <el-table-column label="失败次数" min-width="80" align="center">
            <template #default="{ row }">
              <span :class="{ 'text-danger': Number(row.fail_count) > 5 }">{{ row.fail_count }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="last_fail" label="最后失败" min-width="140" />
          <template #empty>
            <el-empty description="今日无失败" :image-size="40" />
          </template>
        </el-table>
      </ChartCard>

      <ChartCard title="设备消息排行（今日）">
        <el-table :data="deviceRanking" size="small" style="width: 100%">
          <el-table-column prop="device_code" label="设备" min-width="160" />
          <el-table-column prop="count" label="消息数" min-width="80" align="center" />
          <template #empty>
            <el-empty description="暂无数据" :image-size="40" />
          </template>
        </el-table>
      </ChartCard>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  adminApi,
  metricsApi,
  type AdminOverview,
  type DailyTrendPoint,
  type StatusDashboard,
} from '../api/metrics'
import ChartCard from '../components/metrics/ChartCard.vue'

const STATE_LABELS: Record<string, string> = {
  new: '新对话',
  active: '对话中',
  waiting: '等待回复',
  silent: '沉默',
  disqualified: '不符合',
  silent_invite: '已邀约',
  followup_invite: '已邀约',
  pending_invite: '待邀约',
  ai_abnormal: 'AI异常',
}

const route = useRoute()
const loading = ref(false)
const overview = ref<AdminOverview | null>(null)
const status = ref<StatusDashboard | null>(null)
const lastRefresh = ref<Date | null>(null)
let refreshTimer: number | undefined

const isDeviceReport = computed(() => route.path.startsWith('/device-report'))
const pageTitle = computed(() => (isDeviceReport.value ? '设备报表' : '监控看板'))

const lastRefreshText = computed(() => {
  if (!lastRefresh.value) return '尚未刷新'
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = lastRefresh.value
  return `最后刷新 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
})

function display(value: number | undefined | null): number | string {
  return value === undefined || value === null ? '—' : value
}

const overviewItems = computed(() => [
  { label: '系统账号', value: display(overview.value?.total_users) },
  { label: '启用账号', value: display(overview.value?.active_users) },
  { label: '招聘员', value: display(overview.value?.recruiters) },
  { label: '城市', value: display(overview.value?.cities) },
  { label: '岗位', value: display(overview.value?.positions) },
  { label: '坐席设备', value: display(overview.value?.devices) },
  { label: '会话', value: display(overview.value?.conversations) },
  { label: '待处理激活', value: display(overview.value?.pending_activations) },
  { label: '重试任务', value: display(overview.value?.retry_jobs) },
  { label: '失败任务', value: display(overview.value?.dead_jobs) },
  { label: '拒绝的回调', value: display(overview.value?.rejected_webhooks) },
])

const deviceTotal = computed(() => display(status.value?.devices?.total))
const deviceActiveToday = computed(() => display(status.value?.devices?.active_today))
const messageTotal = computed(() => Number(status.value?.messages?.total ?? 0))
const queuePending = computed(() => Number(status.value?.queue?.pending ?? 0))
const difyFailed = computed(() => Number(status.value?.errors?.failed_today ?? 0))
const aiAbnormal = computed(() => Number(status.value?.errors?.ai_abnormal ?? 0))

const dailyTrend = computed<DailyTrendPoint[]>(() => status.value?.daily_trend ?? [])
const hourlyMessages = computed(() => status.value?.messages?.hourly ?? [])
const stateEntries = computed(() => Object.entries(status.value?.state_distribution ?? {}))
const difyHealth = computed(() => status.value?.dify_health ?? [])
const deviceRanking = computed(() => status.value?.device_ranking ?? [])
const degradedDevices = computed(() => status.value?.degraded ?? [])

const dailyMax = computed(() => {
  const values = dailyTrend.value.map((item) => Number(item.total) || 0)
  return Math.max(1, ...values)
})

const hourlyMax = computed(() => {
  const values = hourlyMessages.value.map((item) => Number(item.count) || 0)
  return Math.max(1, ...values)
})

const stateTotal = computed(() =>
  stateEntries.value.reduce((sum, [, value]) => sum + (Number(value) || 0), 0),
)

function dailyBarHeight(value: number): number {
  return Math.max(4, ((Number(value) || 0) / dailyMax.value) * 100)
}

function hourlyBarHeight(value: number): number {
  return Math.max(4, ((Number(value) || 0) / hourlyMax.value) * 120)
}

function statePercent(value: number): number {
  if (!stateTotal.value) return 0
  return ((Number(value) || 0) / stateTotal.value) * 100
}

function stateLabel(key: string): string {
  return STATE_LABELS[key] || key
}

function shortDay(date: string): string {
  return String(date || '').slice(8, 10)
}

let refreshInFlight = false

async function refresh(silent = false): Promise<void> {
  // 防止手动刷新与 3 分钟自动刷新并发导致旧值覆盖新值
  if (refreshInFlight) return
  refreshInFlight = true
  if (!silent) loading.value = true
  try {
    await doRefresh(silent)
  } finally {
    refreshInFlight = false
    if (!silent) loading.value = false
  }
}

async function doRefresh(silent = false): Promise<void> {
  const [overviewResult, statusResult] = await Promise.allSettled([
    adminApi.overview(),
    metricsApi.statusDashboard(),
  ])

  let failed = 0
  if (overviewResult.status === 'fulfilled') {
    overview.value = overviewResult.value.data
  } else {
    failed += 1
  }

  if (statusResult.status === 'fulfilled') {
    status.value = statusResult.value.data
  } else {
    failed += 1
  }

  lastRefresh.value = new Date()
  if (failed > 0) {
    ElMessage.error(failed === 2 ? '看板数据加载失败' : '部分看板数据加载失败')
  }
}

onMounted(() => {
  void refresh()
  refreshTimer = window.setInterval(() => {
    void refresh(true)
  }, 3 * 60 * 1000)
})

onUnmounted(() => {
  if (refreshTimer !== undefined) {
    window.clearInterval(refreshTimer)
    refreshTimer = undefined
  }
})
</script>

<style scoped>
.dashboard {
  width: 100%;
  min-width: 0;
}

.refresh-hint {
  color: var(--bd-text-tertiary);
  font-size: 12px;
  white-space: nowrap;
}

.admin-overview {
  margin-bottom: 16px;
}

.overview-title {
  margin: 0 0 12px;
  color: var(--bd-text-primary);
  font-size: 16px;
  font-weight: 600;
}

.admin-overview-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}

.admin-overview-card {
  min-width: 0;
  min-height: 72px;
  padding: 12px 14px;
}

.admin-overview-value {
  color: var(--bd-text-primary);
  font-size: 22px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.admin-overview-label {
  margin-top: 6px;
  color: var(--bd-text-tertiary);
  font-size: 12px;
}

.stats-row {
  gap: 12px;
  margin-bottom: 16px;
}

.stats-row > .stat-card {
  flex: 1 1 0;
  min-width: 0;
  padding: 20px 24px;
}

.stat-value {
  margin-bottom: 4px;
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.stat-sub {
  margin-top: 4px;
  color: var(--bd-text-tertiary);
  font-size: 11px;
}

.stat-warn {
  border-color: #e6a23c;
}

.stat-warn .stat-value {
  color: #e6a23c;
}

.stat-danger {
  border-color: #f56c6c;
}

.stat-danger .stat-value {
  color: #f56c6c;
}

.trend-card {
  margin-bottom: 16px;
}

.chart-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 16px;
}

.chart-row > .chart-card {
  flex: 1 1 420px;
  min-width: 0;
}

.chart-row > .state-card {
  flex: 0 1 300px;
  min-width: 280px;
}

.chart-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 140px;
}

.daily-chart {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 120px;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
}

.daily-col {
  display: flex;
  flex: 0 0 44px;
  flex-direction: column;
  align-items: center;
  width: 44px;
}

.daily-bar-group {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 100%;
}

.daily-bar {
  width: 18px;
  min-height: 4px;
  border-radius: 2px 2px 0 0;
  transition: height 0.3s;
}

.daily-total {
  background: #409eff;
}

.daily-invited {
  background: #67c23a;
}

.daily-total-num {
  margin-top: 2px;
  color: #409eff;
  font-size: 11px;
  font-weight: 600;
}

.daily-label {
  margin-top: 2px;
  color: #909399;
  font-size: 10px;
}

.daily-rate {
  color: #67c23a;
  font-size: 10px;
  font-weight: 500;
}

.daily-legend {
  display: flex;
  gap: 16px;
  margin-top: 8px;
  color: #909399;
  font-size: 12px;
}

.legend-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 4px;
  border-radius: 50%;
  vertical-align: middle;
}

.legend-rate {
  margin-left: auto;
  color: #67c23a;
}

.bar-chart {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 140px;
  max-width: 100%;
  overflow: hidden;
}

.bar-item {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  align-items: center;
  min-width: 0;
  height: 100%;
  justify-content: flex-end;
}

.bar {
  width: 100%;
  max-width: 16px;
  min-height: 4px;
  border-radius: 2px 2px 0 0;
  background: linear-gradient(#409eff, #337ecc);
  transition: height 0.3s;
}

.bar-label {
  margin-top: 4px;
  color: #909399;
  font-size: 10px;
}

.state-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.state-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.state-name {
  flex-shrink: 0;
  width: 70px;
  color: var(--bd-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state-bar-bg {
  flex: 1 1 0;
  height: 8px;
  border-radius: 4px;
  background: #f0f2f5;
  overflow: hidden;
}

.state-bar {
  height: 100%;
  border-radius: 4px;
  background: #409eff;
  transition: width 0.3s;
}

.state-cnt {
  width: 30px;
  color: var(--bd-text-primary);
  font-weight: 500;
  text-align: right;
}

.degraded-alert {
  margin-bottom: 16px;
}

.degraded-line {
  font-size: 12px;
  line-height: 1.7;
}

.text-danger {
  color: #f56c6c;
  font-weight: 600;
}

@media (max-width: 1200px) {
  .admin-overview-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .chart-row > .state-card {
    flex: 1 1 420px;
  }
}

@media (max-width: 760px) {
  .admin-overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stats-row {
    flex-wrap: wrap;
  }

  .stats-row > .stat-card {
    flex: 1 1 140px;
  }
}
</style>
