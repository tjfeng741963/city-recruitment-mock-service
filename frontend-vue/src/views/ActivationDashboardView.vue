<template>
  <section class="activation-dashboard">
    <div class="page-header">
      <div>
        <h2 class="page-title">激活看板</h2>
      </div>
      <div class="header-actions">
        <el-tooltip
          placement="bottom"
          content="后端未提供 /api/v1/activation/dashboard/stats，无法读取或切换全局暂停状态"
        >
          <span class="disabled-button-wrap">
            <el-button type="danger" plain disabled>全局暂停复聊</el-button>
          </span>
        </el-tooltip>
      </div>
    </div>

    <div class="stats-row activation-stats">
      <div class="stat-card">
        <div class="stat-value stat-placeholder">—</div>
        <div class="stat-label">今日待激活</div>
      </div>
      <div class="stat-card">
        <div class="stat-value stat-placeholder">—</div>
        <div class="stat-label">今日已发送</div>
      </div>
      <div class="stat-card">
        <div class="stat-value stat-placeholder">—</div>
        <div class="stat-label">今日已回复</div>
      </div>
      <div class="stat-card">
        <div class="stat-value stat-placeholder">—</div>
        <div class="stat-label">回复率</div>
      </div>
      <div class="stat-card">
        <div class="stat-value stat-placeholder">—</div>
        <div class="stat-label">冷冻池总量</div>
      </div>
    </div>

    <ApiMissing
      :api="MISSING_APIS.activationDashboardStats"
      class="block-missing"
      hint="指标卡保留旧版结构，待统计接口接入后展示真实数据。"
    />

    <div class="chart-row top-row">
      <ChartCard title="30 天发送与回复趋势" class="wide-card">
        <div class="degraded-body">
          <ApiMissing :api="MISSING_APIS.activationDashboardTrend" />
        </div>
      </ChartCard>
      <ChartCard title="沉淀人群构成" class="narrow-card">
        <div class="degraded-body">
          <ApiMissing :api="MISSING_APIS.activationDashboardPopulation" />
        </div>
      </ChartCard>
    </div>

    <div class="chart-row bottom-row">
      <ChartCard title="策略效果对比（近 30 天）" class="wide-card">
        <el-table :data="[]" size="small" style="width: 100%">
          <el-table-column prop="strategy" label="策略" min-width="150" />
          <el-table-column prop="sent" label="发送量" min-width="90" align="center" />
          <el-table-column prop="replied" label="回复量" min-width="90" align="center" />
          <el-table-column prop="reply_rate" label="回复率" min-width="90" align="center" />
          <el-table-column prop="praise" label="招聘员好评" min-width="100" align="center" />
          <template #empty>
            <div class="table-empty">
              <ApiMissing :api="MISSING_APIS.activationDashboardStrategyEffect" compact />
            </div>
          </template>
        </el-table>
      </ChartCard>
      <ChartCard title="实时动态" class="narrow-card">
        <div class="degraded-body">
          <ApiMissing :api="MISSING_APIS.activationDashboardFeed" />
        </div>
      </ChartCard>
    </div>
  </section>
</template>

<script setup lang="ts">
import ApiMissing from '../components/metrics/ApiMissing.vue'
import ChartCard from '../components/metrics/ChartCard.vue'
import { MISSING_APIS } from '../api/metrics'
</script>

<style scoped>
.activation-dashboard {
  width: 100%;
  min-width: 0;
}

.disabled-button-wrap {
  display: inline-flex;
}

.activation-stats {
  gap: 12px;
  margin-bottom: 16px;
}

.activation-stats > .stat-card {
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

.stat-placeholder {
  color: var(--bd-text-tertiary);
}

.block-missing {
  margin-bottom: 16px;
}

.chart-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 16px;
}

.chart-row > .chart-card {
  min-width: 0;
}

.chart-row > .wide-card {
  flex: 1 1 420px;
}

.chart-row > .narrow-card {
  flex: 1 1 300px;
}

.degraded-body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 260px;
}

.table-empty {
  width: 100%;
  padding: 12px 8px;
}

:deep(.el-table__empty-text) {
  width: 100%;
  line-height: normal;
}

:deep(.el-table__empty-block) {
  height: auto !important;
}

@media (max-width: 1200px) {
  .chart-row > .narrow-card {
    flex: 1 1 420px;
  }
}

@media (max-width: 760px) {
  .activation-stats {
    flex-wrap: wrap;
  }

  .activation-stats > .stat-card {
    flex: 1 1 140px;
  }
}
</style>
