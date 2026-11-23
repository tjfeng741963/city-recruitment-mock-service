<template>
  <div class="mode-control">
    <el-select
      :model-value="status?.effective ?? currentProvider"
      :disabled="!status?.supported || pending || working || confirming || loadError || requestUnconfirmed"
      size="small"
      :aria-label="'回复来源 ' + deviceCode"
      placeholder="正在读取"
      @change="switchMode"
    >
      <el-option label="系统 Agent" value="agent" />
      <el-option label="Dify 工作流" value="dify" />
    </el-select>
    <span class="mode-scope">{{ scopeHint(status?.effective ?? currentProvider) }}</span>

    <div class="mode-feedback" aria-live="polite">
      <template v-if="pending && status">
        <span class="mode-pending">{{ status.rollback ? '正在恢复至' : '正在切换至' }} {{ label(status.target) }} · {{ elapsed }}</span>
        <span>{{ explanation }}{{ seconds >= 45 ? ' 处理时间较长。' : '' }}</span>
        <el-button v-if="!status.rollback" link size="small" :loading="working" :disabled="loadError || requestUnconfirmed"
          @click="cancel">撤回切换</el-button>
      </template>
      <span v-else-if="working" class="mode-pending">正在提交切换请求…</span>
      <span v-else-if="loadError">状态读取失败，正在重试。</span>
      <span v-else-if="!status">正在核对客户端…</span>
      <span v-else-if="!status.supported">需更新并启动 Win 客户端。</span>
      <span v-else-if="status.phase === 'completed'" class="mode-success">已切换 · Win 已确认</span>
      <span v-else-if="status.phase === 'cancelled'">已恢复 · Win 已确认</span>
      <span v-else-if="!status.client_connected">Win 重连后执行切换。</span>
      <span v-else-if="!status.client_ready">等待 Win 确认当前模式。</span>
      <span v-if="operationError" :class="requestUnconfirmed ? 'mode-pending' : 'mode-error'">{{ operationError }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { devicesApi, type ReplyModeStatus, type ReplyProvider } from '../../api/agent'

const props = defineProps<{ deviceCode: string; currentProvider?: ReplyProvider }>()
const emit = defineEmits<{ confirmed: [] }>()
const status = ref<ReplyModeStatus>()
const loadError = ref(false)
const operationError = ref('')
const working = ref(false)
const confirming = ref(false)
const requestUnconfirmed = ref(false)
const sampledAt = ref(Date.now())
const now = ref(Date.now())
let read: AbortController | undefined
let poll: ReturnType<typeof setInterval> | undefined
let clock: ReturnType<typeof setInterval> | undefined
let disposed = false

const pending = computed(() => status.value?.phase === 'waiting' || status.value?.phase === 'applying')
const seconds = computed(() => (status.value?.elapsed_seconds || 0) +
  (pending.value ? Math.max(0, Math.floor((now.value - sampledAt.value) / 1000)) : 0))
const elapsed = computed(() => seconds.value < 60 ? seconds.value + ' 秒'
  : Math.floor(seconds.value / 60) + ' 分 ' + seconds.value % 60 + ' 秒')
const explanation = computed(() => {
  const current = status.value
  if (loadError.value) return '等待网页恢复连接，进度会自动刷新。'
  if (!current?.client_connected) return '等待 Windows 客户端连接。'
  const issues: Record<string, string> = {
    wechat: '等待企业微信登录就绪。', receipt: '等待当前发送回执。', local_state: '正在核对 Windows 的发送账本。',
    configuration: 'Win 未能读取匹配的配置，正在重试。', desktop: '等待 Windows 交互桌面恢复。',
  }
  return issues[current.issue] || (current.phase === 'applying' ? 'Win 正在读取并核对新模式。' : '等待 Win 完成本轮回复。')
})

function label(mode: ReplyProvider) { return mode === 'dify' ? 'Dify' : '系统 Agent' }

function scopeHint(mode?: ReplyProvider) {
  if (mode === 'agent') return 'Agent 使用一个绑定岗位。'
  if (mode === 'dify') return 'Dify 可在配置范围内接待多个岗位。'
  return 'Agent 接待单岗，Dify 支持多岗位。'
}

function apply(next: ReplyModeStatus) {
  const previous = status.value
  status.value = next
  sampledAt.value = Date.now()
  if ((next.phase === 'completed' || next.phase === 'cancelled') &&
      (previous?.id !== next.id || previous?.phase !== next.phase)) {
    if (previous) {
      ElMessage.success(props.deviceCode + (next.phase === 'completed' ? ' 已切换至 ' : ' 已恢复至 ') + label(next.effective))
    }
    emit('confirmed')
  }
}

async function refresh() {
  if (read || working.value || disposed) return
  const controller = new AbortController()
  read = controller
  try {
    const { data } = await devicesApi.replyMode(props.deviceCode, controller.signal)
    if (disposed || controller.signal.aborted) return
    const previousId = status.value?.id
    apply(data)
    loadError.value = false
    if (requestUnconfirmed.value) {
      requestUnconfirmed.value = false
      operationError.value = data.id !== previousId ? '' : '服务端尚无这次操作记录，可重新选择。'
    }
  } catch {
    if (!disposed && !controller.signal.aborted) loadError.value = true
  } finally {
    if (read === controller) read = undefined
  }
}

async function request(payload: { provider: ReplyProvider; id: string } | { cancel: true; id: string }) {
  if (working.value || disposed) return
  read?.abort()
  read = undefined
  working.value = true
  operationError.value = ''
  try {
    const { data } = await devicesApi.requestReplyMode(props.deviceCode, payload)
    if (!disposed) apply(data)
  } catch (err: any) {
    if (disposed) return
    const response = err?.response
    requestUnconfirmed.value = !response || response.status >= 500
    operationError.value = requestUnconfirmed.value
      ? '提交结果待确认，正在重新读取状态。'
      : '切换请求未执行。' + (response.data?.detail || '请刷新后重试。')
  } finally {
    working.value = false
    void refresh()
  }
}

async function switchMode(target: unknown) {
  const current = status.value
  if (!current?.supported || loadError.value || pending.value || working.value || confirming.value
    || requestUnconfirmed.value || target === current.effective || (target !== 'agent' && target !== 'dify')) return

  confirming.value = true
  try {
    await ElMessageBox.confirm(
      `机器码 ${props.deviceCode}。${scopeHint(target)}${target === 'dify' ? '切换后可在接待设置中维护接待工厂。' : '切换后可在接待设置中更换接待岗位。'}`
        + (current.client_connected ? 'Win 完成当前任务后执行切换。' : 'Win 重连后执行切换。')
        + '发送结果不明的记录会保留待核对。',
      '切换回复来源',
      { confirmButtonText: '确认切换', cancelButtonText: '取消', type: 'warning' },
    )
    await request({ provider: target, id: current.id })
  } catch {
    // Closing the dialog keeps the confirmed mode selected.
  } finally {
    confirming.value = false
  }
}

function cancel() {
  if (status.value) void request({ cancel: true, id: status.value.id })
}

onMounted(() => {
  void refresh()
  poll = setInterval(refresh, 2500)
  clock = setInterval(() => { now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => {
  disposed = true
  read?.abort()
  clearInterval(poll)
  clearInterval(clock)
})
</script>

<style scoped>
.mode-control { display: grid; gap: 5px; min-width: 0; padding-block: 3px; }
.mode-feedback { display: grid; gap: 2px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.mode-scope { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.45; }
.mode-feedback:empty { display: none; }
.mode-feedback > .el-button { justify-self: start; margin-left: 0; }
.mode-pending { color: var(--el-color-warning-dark-2); }
.mode-success { color: var(--el-color-success-dark-2); }
.mode-error { color: var(--el-color-danger-dark-2); }
</style>
