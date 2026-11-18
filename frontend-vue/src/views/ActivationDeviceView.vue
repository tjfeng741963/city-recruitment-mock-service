<template>
  <section class="activation-devices">
    <div class="page-header">
      <div>
        <h2 class="page-title">激活设备配置</h2>
        <p class="page-desc">
          每台设备一个开关：开了就按策略给这台设备下的沉淀客户发激活消息，关了立即停止
        </p>
      </div>
      <div class="header-actions">
        <el-tooltip
          placement="bottom"
          content="后端未提供 /api/v1/activation/devices，无法读取设备列表或批量切换"
        >
          <span class="batch-btn-wrap">
            <el-button disabled>批量关闭</el-button>
          </span>
        </el-tooltip>
        <el-tooltip
          placement="bottom"
          content="后端未提供 /api/v1/activation/devices，无法读取设备列表或批量切换"
        >
          <span class="batch-btn-wrap">
            <el-button type="primary" disabled>批量开启</el-button>
          </span>
        </el-tooltip>
      </div>
    </div>

    <div class="table-wrapper">
      <el-table :data="[]" size="small" style="width: 100%">
        <el-table-column type="selection" width="42" />
        <el-table-column label="设备" min-width="180">
          <template #default>
            <div class="device-cell">
              <span class="device-name">—</span>
              <span class="device-code">—</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="recruiter_id" label="归属招聘员" min-width="140" />
        <el-table-column label="复聊激活" width="120">
          <template #default>
            <el-switch :model-value="false" disabled />
          </template>
        </el-table-column>
        <el-table-column label="今日已发" min-width="120">
          <template #default>—</template>
        </el-table-column>
        <el-table-column label="AI 接管" min-width="150">
          <template #default>—</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default>
            <el-button link type="primary" disabled>编辑</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="table-empty">
            <ApiMissing
              :api="MISSING_APIS.activationDevices"
              compact
              hint="设备开关列表结构已保留；接口接入后可逐台开关或批量切换。"
            />
          </div>
        </template>
      </el-table>
    </div>
  </section>
</template>

<script setup lang="ts">
import ApiMissing from '../components/metrics/ApiMissing.vue'
import { MISSING_APIS } from '../api/metrics'
</script>

<style scoped>
.activation-devices {
  width: 100%;
  min-width: 0;
}

.batch-btn-wrap {
  display: inline-flex;
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

.device-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.device-name {
  color: var(--bd-text-primary);
  font-weight: 600;
}

.device-code {
  color: var(--bd-text-tertiary);
  font-size: 12px;
}
</style>
