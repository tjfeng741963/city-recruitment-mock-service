<template>
  <section class="activation-strategy">
    <div class="page-header">
      <div>
        <h2 class="page-title">激活策略配置</h2>
        <p class="page-desc">
          策略决定“谁在什么时候被激活”；A 类激活消息从复聊语料库随机抽取（「语料库」菜单维护），客户回复后仍由原 Dify 对话接管
        </p>
        <p class="page-desc warning-desc">
          配置按账号隔离：管理员看到的是全局默认模板（各账号未自定义时生效）；总账号保存后即生成自己账号的独立配置，此后管理员改全局模板不再影响已自定义的账号
        </p>
      </div>
    </div>

    <div class="engine-card">
      <h3 class="card-title">调度引擎配置</h3>
      <el-form label-width="140px" class="engine-form">
        <div class="engine-grid">
          <el-form-item label="每日调度时间">
            <div class="field-wrap">
              <el-time-picker
                v-model="scheduleTime"
                format="HH:mm"
                placeholder="调度时间"
                class="time-picker"
              />
              <div class="form-hint">每天到点扫描各策略名单，生成今日待激活队列</div>
            </div>
          </el-form-item>

          <el-form-item label="免人工审核">
            <div class="field-wrap">
              <el-switch v-model="autoReview" />
              <div class="form-hint">
                开启后话术生成完毕直接进入发送队列，无需人工逐条审核；「误判捞回」策略不受此开关影响，始终需要人工审核
              </div>
            </div>
          </el-form-item>
        </div>

        <el-form-item>
          <el-button type="primary" @click="saveEngine">保存引擎配置</el-button>
        </el-form-item>
      </el-form>
    </div>

    <ChartCard title="激活策略" class="strategy-list">
      <ApiMissing
        :api="MISSING_APIS.activationStrategies"
        hint="策略开关、触发条件、发送时段与三档推送参数均依赖该接口；表单可本地编辑，但无法读取或保存后端配置。"
      />
    </ChartCard>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import ApiMissing from '../components/metrics/ApiMissing.vue'
import ChartCard from '../components/metrics/ChartCard.vue'
import { MISSING_APIS } from '../api/metrics'

const scheduleTime = ref<Date>(new Date(2000, 0, 1, 9, 0, 0))
const autoReview = ref(false)

function saveEngine(): void {
  ElMessage.warning(`后端未提供 ${MISSING_APIS.activationStrategies}`)
}
</script>

<style scoped>
.activation-strategy {
  width: 100%;
  min-width: 0;
}

.warning-desc {
  color: #a14f00;
}

.engine-card {
  padding: 20px;
  margin-bottom: 16px;
}

.card-title {
  margin: 0 0 18px;
  color: var(--bd-text-primary);
  font-size: 15px;
  font-weight: 600;
}

.engine-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 24px;
}

.field-wrap {
  min-width: 0;
}

.time-picker {
  width: 140px;
  max-width: 100%;
}

.form-hint {
  margin-top: 6px;
  color: var(--bd-text-tertiary);
  font-size: 12px;
  line-height: 1.6;
}

.strategy-list {
  min-width: 0;
}

@media (max-width: 900px) {
  .engine-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
