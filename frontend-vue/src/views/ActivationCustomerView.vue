<template>
  <section class="activation-customers">
    <div class="page-header">
      <div>
        <h2 class="page-title">激活名单</h2>
        <p class="page-desc">
          待审核记录需人工确认后才会发送；未处理的记录会一直保留，不会被自动清掉；已处理/已回复的可按入单日期回查
        </p>
      </div>
    </div>

    <div class="filter-bar customer-filter">
      <el-select v-model="recruiter" placeholder="招聘员筛选" clearable class="filter-select">
        <el-option label="全部招聘员" value="" />
      </el-select>
      <el-select v-model="status" placeholder="状态筛选" clearable class="filter-select">
        <el-option
          v-for="(item, key) in STATUS_MAP"
          :key="key"
          :label="item.label"
          :value="key"
        />
      </el-select>
      <el-date-picker
        v-model="dateRange"
        type="daterange"
        range-separator="~"
        start-placeholder="入单开始"
        end-placeholder="入单结束"
        value-format="YYYY-MM-DD"
        class="filter-date"
      />
      <el-input
        v-model="keyword"
        placeholder="搜索昵称或客户ID..."
        clearable
        :prefix-icon="Search"
        class="filter-search"
      />
    </div>

    <div class="batch-bar">
      <span class="selected-count">已选 0 条</span>
      <el-button size="small" type="primary" disabled>批量审核通过</el-button>
      <el-button size="small" type="success" disabled>批量发送</el-button>
      <el-button size="small" disabled>批量跳过</el-button>
      <el-button size="small" type="warning" plain disabled>批量冷冻</el-button>
    </div>

    <div class="table-wrapper">
      <el-table :data="[]" size="small" style="width: 100%">
        <el-table-column type="selection" width="42" />
        <el-table-column label="客户" min-width="150" fixed="left">
          <template #default>
            <div class="customer-cell">
              <span class="customer-name">—</span>
              <span class="customer-id">—</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="策略" min-width="150">
          <template #default>—</template>
        </el-table-column>
        <el-table-column label="设备 / 招聘员" min-width="150">
          <template #default>
            <div class="device-name">—</div>
            <div class="recruiter-name">—</div>
          </template>
        </el-table-column>
        <el-table-column label="停滞" width="80">
          <template #default>—</template>
        </el-table-column>
        <el-table-column label="入单时间" width="120">
          <template #default>—</template>
        </el-table-column>
        <el-table-column label="AI 摘要" min-width="220">
          <template #default>—</template>
        </el-table-column>
        <el-table-column label="状态" width="118">
          <template #default>—</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default>
            <el-button link type="primary" disabled>详情</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="table-empty">
            <ApiMissing
              :api="MISSING_APIS.activationCustomers"
              compact
              hint="筛选条与表格列已保留，接口接入后展示真实激活名单。"
            />
          </div>
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
import { ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import ApiMissing from '../components/metrics/ApiMissing.vue'
import { MISSING_APIS } from '../api/metrics'

const STATUS_MAP: Record<string, { label: string }> = {
  pending_extract: { label: '待提取' },
  pending_generate: { label: '待生成' },
  pending_review: { label: '待审核' },
  pending_send: { label: '待发送' },
  sent: { label: '已发送' },
  replied: { label: '已回复' },
  failed: { label: '失败' },
  skipped: { label: '已跳过' },
  frozen: { label: '冷冻中' },
  expired: { label: '已过期' },
}

const recruiter = ref('')
const status = ref('')
const dateRange = ref<[string, string] | null>(null)
const keyword = ref('')
const page = ref(1)
const pageSize = ref(20)
</script>

<style scoped>
.activation-customers {
  width: 100%;
  min-width: 0;
}

.customer-filter {
  flex-wrap: wrap;
  padding: 14px 16px;
}

.filter-select {
  width: 160px;
}

.filter-date {
  width: 240px;
  max-width: 100%;
}

.filter-search {
  width: 240px;
  max-width: 100%;
}

.batch-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.selected-count {
  margin-right: 4px;
  color: var(--bd-text-tertiary);
  font-size: 12px;
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

.customer-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.customer-name {
  color: var(--bd-text-primary);
  font-weight: 600;
}

.customer-id,
.recruiter-name {
  color: var(--bd-text-tertiary);
  font-size: 12px;
}

.device-name {
  color: var(--bd-text-primary);
}

@media (max-width: 760px) {
  .filter-select,
  .filter-date,
  .filter-search {
    width: 100%;
  }
}
</style>
