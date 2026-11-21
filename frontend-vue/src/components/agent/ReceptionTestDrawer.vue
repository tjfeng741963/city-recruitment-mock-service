<template>
  <el-drawer v-model="visible" title="接待测试" size="min(100%, 460px)" append-to-body>
    <div class="test-panel">
      <label for="test-position">测试岗位</label>
      <el-select id="test-position" v-model="testPosition" placeholder="请选择招聘岗位"
        filterable :loading="positionsLoading" :disabled="busy || accountsLoading">
        <el-option v-for="position in positions" :key="position.id" :value="position.id"
          :label="[position.city_name, position.position_name].filter(Boolean).join(' · ')" />
      </el-select>

      <el-tabs v-model="engine" aria-label="测试引擎">
        <el-tab-pane label="系统 Agent" name="agent">
          <PositionQa v-if="visible && engine === 'agent'" :key="testPosition || 0" :position-id="testPosition || 0" />
        </el-tab-pane>
        <el-tab-pane label="Dify 工作流" name="dify">
          <p class="hint">模拟对话使用当前岗位资料和适用问答。流程节点在 Dify 后台维护。</p>
          <form class="test-form" @submit.prevent="preview(true)">
            <label for="dify-question">求职者问题</label>
            <el-input id="dify-question" v-model="question" type="textarea" :rows="3" maxlength="2000"
              placeholder="例如，推荐岗位、查看面试安排。报名试填请使用虚构姓名和手机号。" />
            <div class="actions">
              <el-button type="primary" native-type="submit" :disabled="!canPreview" :loading="busy === 'answer'">生成模拟回答</el-button>
              <el-button :disabled="!canPreview" :loading="busy === 'evidence'" @click="preview(false)">查看回答依据</el-button>
              <el-button link :disabled="!!busy" @click="resetTest">新建测试会话</el-button>
            </div>
          </form>
          <el-alert v-if="testError" :title="testError" type="error" :closable="false" show-icon />
          <p v-if="testNotice" class="hint" role="status">{{ testNotice }}</p>
          <div v-if="turns.length" class="test-results" aria-live="polite">
            <div v-for="(turn, index) in turns" :key="index">
              <p><strong>求职者</strong> {{ turn.question }}</p>
              <p class="reply"><strong>Dify</strong> {{ turn.answer }}</p>
            </div>
          </div>
          <details v-if="evidence !== null" class="evidence" open>
            <summary>Dify 输入预览</summary>
            <p class="hint">{{ evidenceSummary }}</p>
            <pre>{{ evidence }}</pre>
          </details>
        </el-tab-pane>
      </el-tabs>

      <details :open="!!initialDevice" class="account-settings">
        <summary>账号回复来源</summary>
        <p class="hint">在微信账号列表的「回复来源」列切换正式接待模式。</p>
        <el-select v-model="deviceCode" aria-label="选择微信账号" placeholder="选择微信账号"
          filterable clearable :loading="accountsLoading">
          <el-option v-for="device in devices" :key="device.id" :value="device.device_code"
            :label="(device.name || device.device_code) + ' · ' + device.device_code" />
        </el-select>
        <el-alert v-if="accountError" :title="accountError" type="error" :closable="false" show-icon />
        <p v-if="selectedDevice?.reply_provider" class="hint">
          已确认来源 {{ selectedDevice.reply_provider === 'dify' ? 'Dify 工作流' : '系统 Agent' }}。
        </p>
        <router-link to="/agent-devices">前往微信账号列表</router-link>
      </details>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import PositionQa from './PositionQa.vue'
import { agentApi, devicesApi, type AgentDeviceItem } from '../../api/agent'
import type { ServicePosition } from '../../api/types'

type Engine = 'agent' | 'dify'
const visible = defineModel<boolean>({ required: true })
const props = defineProps<{
  positionId: number
  positions: ServicePosition[]
  positionsLoading: boolean
  initialEngine: Engine
  initialDevice: string
}>()

const engine = ref<Engine>(props.initialEngine)
const testPosition = ref<number | undefined>(props.initialDevice ? undefined : props.positionId || undefined)
const question = ref('')
const turns = ref<Array<{ question: string; answer: string }>>([])
const evidence = ref<string | null>(null)
const evidenceSummary = ref('')
const testError = ref('')
const testNotice = ref('')
const busy = ref<'answer' | 'evidence'>()
const canPreview = computed(() => !!testPosition.value && !!question.value.trim() && !busy.value && !props.positionsLoading)
let previewRequest: AbortController | undefined
let session = newTestSession()

function newTestSession(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return 'dify-preview:' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function resetTest(): void {
  previewRequest?.abort()
  previewRequest = undefined
  busy.value = undefined
  session = newTestSession()
  turns.value = []
  evidence.value = null
  evidenceSummary.value = ''
  testError.value = ''
  testNotice.value = ''
}

function errorText(error: unknown, fallback: string): string {
  const detail = (error as {response?: {data?: {detail?: unknown}}})?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return error instanceof Error ? error.message : fallback
}

async function preview(generate: boolean): Promise<void> {
  const position = testPosition.value
  const text = question.value.trim()
  if (!position || !canPreview.value) return
  const controller = new AbortController()
  previewRequest = controller
  const current = () => previewRequest === controller
  busy.value = generate ? 'answer' : 'evidence'
  evidence.value = null
  testError.value = ''
  testNotice.value = ''
  try {
    const { data } = await agentApi.difyPreview({ position_id: position, text, session_key: session, dry: true }, controller.signal)
    if (!current()) return
    if (!data.ok || !data.inputs) throw new Error(data.error || '读取 Dify 岗位资料失败')
    const input = JSON.parse(data.inputs.position_data)
    const wageSource = input.sources?.fields?.wage_text
    const wage = wageSource === 'city' ? '城市资料' : wageSource === 'position_fallback' ? '岗位补充' : '未提供'
    const knowledge = Array.isArray(input.knowledge) ? input.knowledge.length : 0
    const omitted = Number(input.retrieval?.omitted) || 0
    evidenceSummary.value = [input.job_title ? `岗位 ${input.job_title}` : '', `城市 ${input.city || '未提供'}`, `工资来源 ${wage}`, `${knowledge} 条适用问答`,
      omitted ? `${omitted} 条资料未纳入本次输入` : ''].filter(Boolean).join(' · ')
    evidence.value = JSON.stringify(input, null, 2)
    if (!generate) return
    const { data: answer } = await agentApi.difyPreview({ position_id: position, text, session_key: session }, controller.signal)
    if (!current()) return
    if (!answer.ok || !answer.reply) throw new Error(answer.error || 'Dify 生成失败')
    turns.value.push({ question: text, answer: answer.reply.messages.map(message => message.content).join('\n\n') })
    const duration = answer.latency_ms == null ? '' : `，耗时 ${(answer.latency_ms / 1000).toFixed(1)} 秒`
    testNotice.value = `模拟回复已生成${duration}。本次为网页预览。`
  } catch (error) {
    if (current()) testError.value = errorText(error, 'Dify 模拟失败')
  } finally {
    if (current()) {
      previewRequest = undefined
      busy.value = undefined
    }
  }
}

const devices = ref<AgentDeviceItem[]>([])
const deviceCode = ref<string | undefined>()
const accountError = ref('')
const accountsLoading = ref(false)
const selectedDevice = computed(() => devices.value.find(device => device.device_code === deviceCode.value))

async function loadAccounts(): Promise<void> {
  accountsLoading.value = true
  accountError.value = ''
  try {
    const { data } = await devicesApi.list()
    devices.value = data.items
    if (!props.initialDevice || deviceCode.value) return
    const device = data.items.find(item => item.device_code === props.initialDevice)
    if (!device) {
      accountError.value = '指定账号不存在或无权访问，请重新选择。'
      return
    }
    deviceCode.value = device.device_code
  } catch (error) {
    accountError.value = errorText(error, '读取微信账号失败')
  } finally {
    accountsLoading.value = false
  }
}

let initialPositionResolved = false
watch([devices, () => props.positions, () => props.positionsLoading], ([accounts, positions, loading]) => {
  if (!props.initialDevice || initialPositionResolved || loading || !positions.length) return
  const device = accounts.find(item => item.device_code === props.initialDevice)
  if (!device) return
  initialPositionResolved = true
  const boundPosition = positions.find(position => position.id === Number(device.position_id))
  if (boundPosition) testPosition.value = boundPosition.id
}, { immediate: true })

watch(() => props.positionId, id => {
  if (!props.initialDevice) testPosition.value = id || undefined
})
watch([testPosition, engine], resetTest)
watch(visible, open => {
  if (open && !accountsLoading.value) void loadAccounts()
  if (!open) resetTest()
}, { immediate: true })
onBeforeUnmount(() => previewRequest?.abort())
</script>

<style scoped>
.test-panel,.test-form { display: grid; gap: 10px; }
.hint { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
.actions .el-button { margin-left: 0; }
.test-results { display: grid; gap: 8px; margin: 10px 0; overflow-wrap: anywhere; }
.reply,pre { padding: 10px; border-radius: 6px; background: var(--el-fill-color-light); white-space: pre-wrap; overflow-wrap: anywhere; }
.evidence,.account-settings { border-top: 1px solid var(--el-border-color-light); padding-top: 12px; margin-top: 12px; }
.account-settings > :not(summary) { display: block; margin-top: 10px; }
.account-settings .el-select { width: 100%; }
summary { cursor: pointer; font-weight: 600; }
</style>
