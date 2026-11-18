<template>
  <section class="account-summary">
    <div class="page-header">
      <div>
        <h2 class="page-title">郎职师 · 运营汇总</h2>
        <p class="page-desc">按时间范围汇总账号运营数据</p>
      </div>
    </div>

    <div class="filter-bar summary-filter">
      <div class="range-buttons">
        <el-button
          v-for="option in rangeOptions"
          :key="option.value"
          size="small"
          :type="range === option.value ? 'primary' : ''"
          @click="selectRange(option.value)"
        >
          {{ option.label }}
        </el-button>
      </div>
      <el-date-picker
        v-model="customRange"
        type="daterange"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        value-format="YYYY-MM-DD"
        size="small"
        class="range-picker"
        @change="onCustomRangeChange"
      />
      <el-button type="primary" size="small" @click="query">查询</el-button>
      <span class="range-hint">{{ rangeHint }}</span>
    </div>

    <ApiMissing
      :api="MISSING_APIS.accountSummary"
      hint="筛选条件与汇总表格结构已保留；接口接入后会展示真实统计。"
    />

    <div class="table-wrapper summary-table">
      <el-table :data="[]" size="small" style="width: 100%">
        <el-table-column prop="recruiter_id" label="账号" min-width="150" />
        <el-table-column prop="name" label="名称" min-width="110" />
        <el-table-column prop="device_count" label="设备数" width="80" align="center" />
        <el-table-column prop="new_total" label="新增" width="80" align="center" />
        <el-table-column prop="invited" label="邀约" width="80" align="center" />
        <el-table-column prop="pending_invite" label="待邀约" width="90" align="center" />
        <el-table-column prop="disqualified" label="不符合" width="90" align="center" />
        <el-table-column prop="checked_in" label="签到" width="80" align="center" />
        <el-table-column label="邀约率" width="90" align="center">
          <template #default>—</template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无数据" :image-size="70" />
        </template>
      </el-table>
      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="0"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import ApiMissing from '../components/metrics/ApiMissing.vue'
import { MISSING_APIS } from '../api/metrics'

type RangeValue = 'today' | 'week' | 'month' | 'custom'

const rangeOptions: { label: string; value: RangeValue }[] = [
  { label: '今天', value: 'today' },
  { label: '本周', value: 'week' },
  { label: '本月', value: 'month' },
]

const range = ref<RangeValue>('month')
const customRange = ref<[string, string] | null>(null)
const page = ref(1)
const pageSize = ref(20)

const rangeHint = computed(() => {
  const labels: Record<RangeValue, string> = {
    today: '今天',
    week: '本周',
    month: '本月',
    custom: '自定义',
  }
  if (range.value === 'custom' && customRange.value) {
    return `${customRange.value[0]} 至 ${customRange.value[1]}`
  }
  return labels[range.value]
})

function selectRange(value: RangeValue): void {
  range.value = value
  if (value !== 'custom') customRange.value = null
}

function onCustomRangeChange(value: [string, string] | null): void {
  range.value = value?.length === 2 ? 'custom' : 'month'
}

function query(): void {
  ElMessage.warning(`后端未提供 ${MISSING_APIS.accountSummary}`)
}
</script>

<style scoped>
.account-summary {
  width: 100%;
  min-width: 0;
}

.summary-filter {
  flex-wrap: wrap;
  align-items: center;
  padding: 14px 16px;
}

.range-buttons {
  display: inline-flex;
  gap: 4px;
}

.range-picker {
  width: 240px;
  max-width: 100%;
}

.range-hint {
  color: var(--bd-text-tertiary);
  font-size: 12px;
}

.summary-table {
  margin-top: 16px;
}

@media (max-width: 760px) {
  .range-picker {
    width: 100%;
  }
}
</style>
