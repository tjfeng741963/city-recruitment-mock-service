<template>
  <div class="mode-control">
    <el-alert v-if="loadError" title="暂时无法核对切换状态" type="warning" :closable="false" />
    <template v-if="status">
      <div class="mode-summary">
        <strong>{{ status.client_ready && !pending ? "正在使用" : "上次确认" }} {{ label(status.effective) }}</strong>
        <el-tag v-if="pending" type="warning">{{ status.rollback ? '正在恢复' : '正在切换' }}至 {{ label(status.target) }}</el-tag>
        <el-tag v-else-if="status.phase === 'completed'" type="success">已切换</el-tag>
        <el-tag v-else-if="status.phase === 'cancelled'" type="info">已恢复</el-tag>
      </div>
      <div v-if="pending" class="mode-progress">
        <el-steps :active="status.phase === 'applying' ? 1 : 0" simple>
          <el-step title="等待当前任务结束" />
          <el-step title="Win 应用配置" />
          <el-step title="确认完成" />
        </el-steps>
        <div class="mode-note" aria-live="polite">{{ explanation }}</div>
        <div class="mode-note">已等待 {{ elapsed }}{{ seconds >= 45 ? '，切换比平时慢' : '' }}</div>
        <el-button v-if="!status.rollback" size="small" :loading="working" :disabled="loadError"
          @click="cancel">撤回切换</el-button>
      </div>
      <div v-else-if="status.supported" class="mode-actions">
        <el-button size="small" :loading="working" :disabled="loadError" @click="switchMode">
          切换至 {{ label(alternate) }}
        </el-button>
        <span v-if="!status.client_connected" class="mode-note">Win 重连后执行</span>
        <span v-else-if="!status.client_ready" class="mode-note">等待客户端确认当前模式</span>
      </div>
      <div v-else class="mode-note">请更新并启动 Windows 客户端，等待它上报后即可切换。</div>
    </template>
    <div v-else-if="!loadError" class="mode-note">正在读取设备当前模式…</div>
    <el-alert v-if="operationError" :title="operationError" type="error" :closable="false" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { devicesApi, type ReplyModeStatus, type ReplyProvider } from '../../api/agent'

const props = defineProps<{ deviceCode: string }>()
const emit = defineEmits<{ confirmed: [] }>()
const status = ref<ReplyModeStatus>()
const loadError = ref(false)
const operationError = ref('')
const working = ref(false)
const sampledAt = ref(Date.now())
const now = ref(Date.now())
let read: AbortController | undefined
let poll: ReturnType<typeof setInterval> | undefined
let clock: ReturnType<typeof setInterval> | undefined
let disposed = false

const pending = computed(() => status.value?.phase === 'waiting' || status.value?.phase === 'applying')
const alternate = computed<ReplyProvider>(() => status.value?.effective === 'agent' ? 'dify' : 'agent')
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

function apply(next: ReplyModeStatus) {
  const previous = status.value
  status.value = next
  sampledAt.value = Date.now()
  if ((next.phase === 'completed' || next.phase === 'cancelled') &&
      (previous?.id !== next.id || previous?.phase !== next.phase)) emit('confirmed')
}

async function refresh() {
  if (read || working.value || disposed) return
  const controller = new AbortController()
  read = controller
  try {
    const { data } = await devicesApi.replyMode(props.deviceCode, controller.signal)
    if (!disposed && !controller.signal.aborted) { apply(data); loadError.value = false }
  } catch {
    if (!disposed && !controller.signal.aborted) loadError.value = true
  } finally {
    if (read === controller) read = undefined
  }
}

async function request(payload: { provider: ReplyProvider; id: string } | { cancel: true; id: string }) {
  if (working.value || disposed) return
  read?.abort()
  working.value = true
  operationError.value = ''
  try {
    const { data } = await devicesApi.requestReplyMode(props.deviceCode, payload)
    if (!disposed) apply(data)
  } catch (err: any) {
    if (!disposed) operationError.value = err?.response?.data?.detail || '请求结果暂未确认，正在重新读取状态。'
  } finally {
    working.value = false
    void refresh()
  }
}

async function switchMode() {
  const current = status.value
  if (!current) return
  const target = alternate.value
  try {
    await ElMessageBox.confirm('Win 将在当前任务结束后切换到 ' + label(target) + '。如有未确认发送，会保留待核对。', '切换回复来源', {
      confirmButtonText: '确认切换', cancelButtonText: '取消', type: 'warning',
    })
  } catch { return }
  await request({ provider: target, id: current.id })
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
.mode-control { width: 100%; display: grid; gap: 8px; }
.mode-summary, .mode-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mode-progress { display: grid; gap: 6px; width: 100%; }
.mode-progress > .el-button { justify-self: start; }
.mode-note { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.55; }
.mode-progress :deep(.el-steps) { padding: 8px; }
.mode-progress :deep(.el-step__title) { font-size: 12px; }
</style>
