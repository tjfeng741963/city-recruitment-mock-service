<template>
  <section class="conv-page">
    <div class="conv-container" :class="{ 'left-collapsed': leftCollapsed }">
      <aside class="left-panel">
        <div class="panel-title">
          <span>设备列表</span>
          <el-button link size="small" aria-label="收起设备列表" @click="leftCollapsed = true">收起</el-button>
        </div>
        <div v-loading="devicesLoading" class="device-list">
          <div
            v-for="device in devices"
            :key="device.id"
            class="device-item"
            :class="{ active: activeDevice?.id === device.id }"
            @click="selectDevice(device)"
          >
            <span class="online-dot" :class="isOnline(device) ? 'on' : 'off'" />
            <span class="device-name" :title="device.name || device.device_code">
              {{ device.name || device.device_code }}
            </span>
            <span v-if="!isOnline(device)" class="offline-tag">掉线</span>
            <span v-if="device.queue_depth" class="queue-indicator warn">队列 {{ device.queue_depth }}</span>
            <el-badge
              v-if="deviceUnread[device.id]"
              :value="deviceUnread[device.id]"
              :max="99"
              class="device-badge"
            />
          </div>
          <el-empty v-if="!devicesLoading && !devices.length" description="暂无设备" :image-size="60" />
          <p v-if="devicesError" class="panel-error">{{ devicesError }}</p>
        </div>
      </aside>

      <div class="mid-panel">
        <div class="panel-title panel-title-wrap">
          <div class="mid-title-row">
            <span>客户列表</span>
            <span class="mid-actions">
              <el-button v-if="returnToRecontact" link size="small" @click="router.push(returnToRecontact)">返回发送记录</el-button>
              <el-button v-if="leftCollapsed" link size="small" @click="leftCollapsed = false">展开设备</el-button>
              <el-button link size="small" :loading="convLoading" @click="loadConversations()">刷新</el-button>
            </span>
          </div>
          <div class="filter-row">
            <el-select v-model="statusFilter" size="small" class="filter-select" @change="onStatusChange">
              <el-option label="全部" value="all" />
              <el-option label="进行中" value="active" />
              <el-option label="待邀约" value="pending_invite" />
              <el-option label="已邀约" value="invited" />
              <el-option label="不符合" value="disqualified" />
              <el-option label="AI异常" value="ai_abnormal" />
            </el-select>
            <el-date-picker
              v-model="dateRange"
              type="daterange"
              size="small"
              value-format="YYYY-MM-DD"
              range-separator="~"
              start-placeholder="开始"
              end-placeholder="结束"
              class="filter-daterange"
              @change="loadConversations()"
            />
          </div>
        </div>
        <div v-loading="convLoading" class="customer-list">
          <el-alert
            v-if="convError"
            class="panel-alert"
            type="error"
            :title="convError"
            show-icon
            :closable="false"
          />
          <div
            v-for="conversation in filteredConversations"
            :key="conversation.customer_id"
            class="customer-item"
            :class="{ active: activeConversation?.customer_id === conversation.customer_id }"
            @click="selectConversation(conversation)"
          >
            <div class="customer-avatar-wrap">
              <el-badge
                :value="conversation.unread"
                :hidden="!conversation.unread || conversation.is_old_friend"
                :max="99"
              >
                <el-avatar
                  :size="40"
                  :style="{ background: avatarColor(conversation) }"
                >
                  {{ String(conversation.nickname || conversation.customer_id).slice(0, 2) }}
                </el-avatar>
              </el-badge>
              <el-icon class="state-icon" :class="stateMeta(conversation).cls">
                <component :is="stateMeta(conversation).icon" />
              </el-icon>
            </div>
            <div class="customer-info">
              <div class="customer-name">
                {{ conversation.nickname || conversation.customer_id }}
                <el-tag v-if="conversation.is_old_friend" type="info" size="small" effect="plain">老友</el-tag>
                <span
                  v-if="conversation.remark && conversation.remark !== (conversation.nickname || conversation.customer_id)"
                  class="customer-remark"
                >
                  {{ conversation.remark }}
                </span>
              </div>
              <div v-if="conversation.name || conversation.phone" class="customer-sub-line">
                <span v-if="conversation.name" class="sub-name">{{ conversation.name }}</span>
                <span v-if="conversation.phone" class="sub-phone">{{ conversation.phone }}</span>
              </div>
              <div v-if="conversation.factory_name || conversation.city" class="customer-sub-line">
                <span v-if="conversation.factory_name" class="sub-factory">{{ conversation.factory_name }}</span>
                <span v-if="conversation.city" class="sub-city">
                  {{ conversation.city }}{{ conversation.district ? `/${conversation.district}` : '' }}
                </span>
              </div>
              <div class="customer-msg">{{ previewMessage(conversation.last_msg) }}</div>
            </div>
            <div class="customer-time">
              <span
                v-if="
                  conversation.interview_date &&
                  (conversation.recruit_status === 'invited' ||
                    conversation.state === 'silent_invite' ||
                    conversation.state === 'followup_invite')
                "
                class="interview-badge"
              >
                📅 {{ conversation.interview_date.slice(5) }}
              </span>
              <span v-else>{{ shortConversationTime(conversation.last_msg_at) }}</span>
            </div>
          </div>
          <el-empty
            v-if="!convLoading && !filteredConversations.length"
            description="暂无客户"
            :image-size="60"
          />
        </div>
      </div>

      <div class="right-panel">
        <template v-if="activeConversation">
          <div class="chat-header">
            <div class="chat-header-left">
              <span class="chat-name">
                <template v-if="activeConversation.name">
                  {{ activeConversation.name }}
                  <span class="chat-nickname">{{ activeConversation.nickname || activeConversation.customer_id }}</span>
                </template>
                <template v-else>{{ activeConversation.nickname || activeConversation.customer_id }}</template>
              </span>
              <el-tag :type="statusTagType(activeConversation)" size="small" effect="dark">
                {{ statusLabel(activeConversation) }}
              </el-tag>
              <el-tag v-if="takeover" type="warning" size="small" effect="light">人工接管中</el-tag>
              <span v-if="activeConversation.takeover" class="muted takeover-hint">历史接管标记</span>
              <el-tag v-if="recipientBinding?.status === 'verified'" type="success" size="small" effect="light">
                备注已核验
              </el-tag>
            </div>
            <div class="chat-actions">
              <el-button
                size="small"
                :type="takeover ? 'warning' : 'default'"
                plain
                @click="toggleTakeover"
              >
                {{ takeover ? '取消接管' : '接管' }}
              </el-button>
              <el-button
                v-if="normalizeStatus(activeConversation) === 'disqualified'"
                size="small"
                plain
                type="success"
                @click="resetDisqualified"
              >
                重置不符合
              </el-button>
              <el-button size="small" type="danger" plain @click="restartConversation">重启会话</el-button>
              <el-button size="small" type="primary" @click="gotoArchive">面试登记</el-button>
            </div>
          </div>

          <div v-if="recipientBinding && recipientBlocked" class="recipient-alert" role="status">
            <div>
              <strong>{{ recipientBinding.status === 'awaiting' ? '等待企微核验' : '待确认发送对象' }}</strong>
              <p v-if="recipientBinding.status === 'awaiting'">
                备注码 <code>{{ recipientBinding.remark }}</code>。点「自动设备注」由客户端写进企微，核验通过后自动更新。
              </p>
              <p v-else-if="recipientBinding.status === 'conflict'">
                企微有同名联系人。待回复消息已保留，请确认这位客户。
              </p>
              <p v-else>企微备注已变化或无法核验。待回复消息已保留，请重新确认。</p>
            </div>
            <el-button
              v-if="recipientBinding.status === 'awaiting'"
              size="small"
              type="primary"
              plain
              :loading="applyingRemark"
              @click="applyRecipientRemark"
            >
              自动设备注
            </el-button>
            <el-button
              v-if="recipientBinding.status !== 'awaiting'"
              size="small"
              type="warning"
              plain
              :loading="issuingRecipient"
              @click="confirmRecipient"
            >
              确认发送对象
            </el-button>
          </div>

          <el-alert
            v-if="msgError"
            class="panel-alert"
            type="error"
            :title="msgError"
            show-icon
            :closable="false"
          />

          <ChatMessageList
            :messages="visibleMessages"
            :loading="msgLoading"
            :has-more="messages.length > visibleCount"
            empty-text="暂无消息"
            @load-more="visibleCount += 50"
          />

          <div class="chat-input">
            <el-input
              v-model="draft"
              type="textarea"
              :rows="2"
              resize="none"
              placeholder="输入消息，Ctrl+Enter 发送"
              aria-label="输入消息，Ctrl+Enter 发送，Enter 换行"
              @keydown.ctrl.enter.prevent="send"
              @keydown.meta.enter.prevent="send"
            />
            <div class="input-foot">
              <el-button type="primary" :loading="sending" :disabled="!draft.trim() || recipientBlocked" @click="send">
                发送
              </el-button>
            </div>
          </div>
        </template>
        <div v-else class="chat-empty">
          <el-empty description="选择一个客户开始聊天" :image-size="100" />
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ChatDotSquare,
  CircleCheck,
  CircleClose,
  Warning,
} from '@element-plus/icons-vue'
import ChatMessageList from '../components/ops/ChatMessageList.vue'
import {
  conversationsApi,
  devicesApi,
  type AgentConversation,
  type AgentDeviceItem,
  type AgentMessage,
} from '../api/agent'
import { createAgentStream } from '../api/realtime'
import { formatDateTime } from '../utils/format'
import { recontactReturnRoute } from '../components/recontact/recontact-view'

const router = useRouter()
const route = useRoute()
const returnToRecontact = computed(() => recontactReturnRoute(route.query))

const devices = ref<AgentDeviceItem[]>([])
const devicesLoading = ref(false)
const devicesError = ref('')
const deviceUnread = ref<Record<number, number>>({})
const activeDevice = ref<AgentDeviceItem | null>(null)

const conversations = ref<AgentConversation[]>([])
const convLoading = ref(false)
const convError = ref('')
const statusFilter = ref('all')
const dateRange = ref<[string, string] | null>(lastWeekRange())

const activeConversation = ref<AgentConversation | null>(null)
const messages = ref<AgentMessage[]>([])
const msgLoading = ref(false)
const msgError = ref('')
const visibleCount = ref(50)
const draft = ref('')
const sending = ref(false)
const issuingRecipient = ref(false)
const applyingRemark = ref(false)
const recipientBinding = computed(() => activeConversation.value?.recipient_binding)
const recipientBlocked = computed(() => recipientBinding.value != null && recipientBinding.value.status !== 'verified')
const takeover = ref(false)
const leftCollapsed = ref(false)

let convTimer: ReturnType<typeof setInterval> | null = null
let msgTimer: ReturnType<typeof setInterval> | null = null

const visibleMessages = computed(() => {
  if (messages.value.length <= visibleCount.value) return messages.value
  return messages.value.slice(messages.value.length - visibleCount.value)
})

const filteredConversations = computed(() => {
  let list = conversations.value
  if (dateRange.value && dateRange.value.length === 2) {
    const [start, end] = dateRange.value
    list = list.filter((item) => {
      const day = (item.last_msg_at || '').slice(0, 10)
      return Boolean(day) && day >= start && day <= end
    })
  }
  if (statusFilter.value && statusFilter.value !== 'all') {
    list = list.filter((item) => normalizeStatus(item) === statusFilter.value)
  }
  return list
})

function lastWeekRange(): [string, string] {
  const end = new Date()
  const start = new Date(end.getTime() - 6 * 86400000)
  const fmt = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return [fmt(start), fmt(end)]
}

function isOnline(device: AgentDeviceItem): boolean {
  return Boolean(device.online || device.status)
}

function normalizeStatus(conversation: AgentConversation): string {
  if (
    conversation.recruit_status === 'invited' ||
    conversation.state === 'silent_invite' ||
    conversation.state === 'followup_invite'
  )
    return 'invited'
  if (conversation.recruit_status === 'disqualified' || conversation.state === 'disqualified')
    return 'disqualified'
  if (conversation.recruit_status === 'pending_invite' || conversation.state === 'pending_invite')
    return 'pending_invite'
  if (conversation.state === 'ai_abnormal') return 'ai_abnormal'
  return 'active'
}

const STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  pending_invite: '待邀约',
  invited: '已邀约',
  disqualified: '不符合',
  ai_abnormal: 'AI异常',
  waiting: '等待回复',
  silent: '沉默',
  timeout_1: '追问1',
  timeout_2: '追问2',
  timeout_3: '追问3',
  new: '新对话',
}

function statusLabel(conversation: AgentConversation): string {
  return STATUS_LABELS[normalizeStatus(conversation)] || conversation.state || '进行中'
}

function statusTagType(conversation: AgentConversation): 'success' | 'warning' | 'danger' | 'info' {
  const status = normalizeStatus(conversation)
  if (status === 'invited') return 'success'
  if (status === 'pending_invite') return 'warning'
  if (status === 'disqualified' || status === 'ai_abnormal') return 'danger'
  return 'info'
}

function stateMeta(conversation: AgentConversation): { icon: unknown; cls: string } {
  const status = normalizeStatus(conversation)
  if (status === 'invited') return { icon: CircleCheck, cls: 'si-green' }
  if (status === 'disqualified') return { icon: CircleClose, cls: 'si-gray' }
  if (status === 'pending_invite') return { icon: CircleCheck, cls: 'si-yellow' }
  if (status === 'ai_abnormal') return { icon: Warning, cls: 'si-red' }
  return { icon: ChatDotSquare, cls: 'si-blue' }
}

const AVATAR_COLORS = ['#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#909399', '#9b59b6']
function avatarColor(conversation: AgentConversation): string {
  const name = String(conversation.nickname || conversation.customer_id || '')
  let hash = 0
  for (let index = 0; index < name.length; index += 1) {
    hash = name.charCodeAt(index) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function previewMessage(content: string): string {
  if (!content) return ''
  if (content.startsWith('###图片')) return '[图片]'
  if (content.startsWith('###文件')) return '[文件]'
  return content
}

function shortConversationTime(value: string): string {
  if (!value) return ''
  const text = formatDateTime(value)
  return text.slice(5, 16)
}

/* ---------- 设备 ---------- */
async function loadDevices(): Promise<void> {
  devicesLoading.value = true
  devicesError.value = ''
  try {
    const { data } = await devicesApi.list({ my: true, page: 1, page_size: 1000 })
    devices.value = data.items || []
    if (!activeDevice.value && devices.value.length) {
      const linkedDevice = returnToRecontact.value ? route.query.device_code : undefined
      const device = typeof linkedDevice === 'string'
        ? devices.value.find(item => item.device_code === linkedDevice)
        : devices.value[0]
      if (!device) {
        devicesError.value = '该企微账号不可访问'
        return
      }
      const linkedCustomer = linkedDevice ? route.query.customer_id : undefined
      if (typeof linkedCustomer === 'string') dateRange.value = null
      await selectDevice(device)
      if (typeof linkedCustomer === 'string') {
        const conversation = conversations.value.find(item => String(item.customer_id) === linkedCustomer)
        if (conversation) await selectConversation(conversation)
        else if (!convError.value) convError.value = '该客户会话不可访问'
      }
    } else if (activeDevice.value) {
      const current = devices.value.find((item) => item.id === activeDevice.value?.id)
      if (current) activeDevice.value = current
    }
    void loadUnreadCounts()
  } catch (err: any) {
    devicesError.value = err?.response?.data?.detail || '设备列表加载失败'
  } finally {
    devicesLoading.value = false
  }
}

async function loadUnreadCounts(): Promise<void> {
  const entries = await Promise.allSettled(
    devices.value.map(async (device) => {
      const { data } = await conversationsApi.list({
        device_code: device.device_code,
        page: 1,
        page_size: 1000,
      })
      return [device.id, data.total_unread || 0] as const
    }),
  )
  const next: Record<number, number> = {}
  for (const entry of entries) {
    if (entry.status === 'fulfilled') next[entry.value[0]] = entry.value[1]
  }
  deviceUnread.value = next
}

async function selectDevice(device: AgentDeviceItem): Promise<void> {
  activeDevice.value = device
  activeConversation.value = null
  messages.value = []
  draft.value = ''
  await loadConversations()
}

/* ---------- 会话 ---------- */
async function loadConversations(silent = false): Promise<void> {
  const device = activeDevice.value
  if (!device) return
  if (!silent) convLoading.value = true
  convError.value = ''
  try {
    const { data } = await conversationsApi.list({
      device_code: device.device_code,
      start_date: dateRange.value?.[0],
      end_date: dateRange.value?.[1],
      status: statusFilter.value === 'all' ? undefined : statusFilter.value,
      page: 1,
      page_size: 1000,
    })
    conversations.value = data.items || []
    deviceUnread.value = {
      ...deviceUnread.value,
      [device.id]: data.total_unread || 0,
    }
    if (activeConversation.value) {
      const current = conversations.value.find(
        (item) => item.customer_id === activeConversation.value?.customer_id,
      )
      if (current) {
        activeConversation.value = current
        takeover.value = Boolean(current.takeover)
      } else {
        activeConversation.value = null
        messages.value = []
      }
    }
  } catch (err: any) {
    if (!silent) convError.value = err?.response?.data?.detail || '会话列表加载失败'
  } finally {
    convLoading.value = false
  }
}

function onStatusChange(): void {
  if (!activeConversation.value || statusFilter.value === 'all') return
  if (normalizeStatus(activeConversation.value) !== statusFilter.value) {
    activeConversation.value = null
    messages.value = []
  }
}

/* ---------- 消息 ---------- */
async function selectConversation(conversation: AgentConversation): Promise<void> {
  const previousUnread = Number(conversation.unread || 0)
  activeConversation.value = conversation
  takeover.value = Boolean(conversation.takeover)
  conversation.unread = 0
  if (activeDevice.value) {
    deviceUnread.value = {
      ...deviceUnread.value,
      [activeDevice.value.id]: Math.max(
        0,
        (deviceUnread.value[activeDevice.value.id] || 0) - previousUnread,
      ),
    }
  }
  visibleCount.value = 50
  draft.value = ''
  await loadMessages(true)
}

// 请求序号：切换会话后旧请求的响应必须作废，否则会把上个会话的消息覆盖进来
let msgSeq = 0

async function loadMessages(reset = false): Promise<void> {
  const device = activeDevice.value
  const conversation = activeConversation.value
  if (!device || !conversation) return
  const seq = ++msgSeq
  if (reset) {
    messages.value = []
    msgLoading.value = true
  }
  msgError.value = ''
  const afterId = reset || !messages.value.length ? 0 : messages.value[messages.value.length - 1].id
  try {
    const { data } = await conversationsApi.messages({
      device_code: device.device_code,
      customer_id: conversation.customer_id,
      after_id: afterId,
    })
    if (seq !== msgSeq) return
    const incoming = [...(data.items || [])].sort((left, right) => left.id - right.id)
    if (afterId === 0) {
      messages.value = incoming
    } else if (incoming.length) {
      const known = new Set(messages.value.map((message) => message.id))
      messages.value = [...messages.value, ...incoming.filter((message) => !known.has(message.id))]
    }
    if (reset) conversation.unread = 0
  } catch (err: any) {
    if (seq === msgSeq && reset) msgError.value = err?.response?.data?.detail || '消息加载失败'
  } finally {
    if (seq === msgSeq && reset) msgLoading.value = false
  }
}

/* ---------- 工具栏 ---------- */
async function toggleTakeover(): Promise<void> {
  const device = activeDevice.value
  const conversation = activeConversation.value
  if (!device || !conversation) return
  const next = !takeover.value
  try {
    await ElMessageBox.confirm(
      next
        ? `确认接管「${conversation.nickname || conversation.customer_id}」？接管后 AI 将暂停自动回复。`
        : '确认取消接管？取消后 AI 将恢复自动回复。',
      next ? '接管会话' : '取消接管',
      { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await conversationsApi.takeover(device.device_code, conversation.customer_id, next)
    takeover.value = next
    conversation.takeover = next ? 1 : 0
    ElMessage.success(next ? '已接管，AI 已暂停' : '已取消接管')
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '操作失败')
  }
}

async function restartConversation(): Promise<void> {
  const device = activeDevice.value
  const conversation = activeConversation.value
  if (!device || !conversation) return
  try {
    await ElMessageBox.confirm(
      `确认重启「${conversation.nickname || conversation.customer_id}」的会话？\n该客户的状态将重置为进行中，AI 会重新开始跟进。`,
      '重启会话',
      { type: 'warning', confirmButtonText: '确认重启', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await conversationsApi.restart(conversation.customer_id, device.device_code)
    ElMessage.success('会话已重启')
    activeConversation.value = null
    messages.value = []
    await loadConversations()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '重启失败')
  }
}

async function resetDisqualified(): Promise<void> {
  const device = activeDevice.value
  const conversation = activeConversation.value
  if (!device || !conversation) return
  try {
    await ElMessageBox.confirm(
      '确认将该客户状态改为「进行中」？之后 AI 将正常回复。',
      '重置不符合',
      { type: 'warning', confirmButtonText: '确认', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await conversationsApi.resetDisqualified(conversation.customer_id, device.device_code)
    conversation.recruit_status = 'none'
    conversation.state = 'active'
    ElMessage.success('已重置为进行中')
    await loadConversations(true)
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '操作失败')
  }
}

function gotoArchive(): void {
  const conversation = activeConversation.value
  if (!conversation) return
  router.push({
    path: '/archive',
    query: {
      device_code: conversation.device_code,
      nickname: conversation.nickname || '',
      customer_id: String(conversation.customer_id),
    },
  })
}

async function confirmRecipient(): Promise<void> {
  const conversation = activeConversation.value
  if (!conversation || issuingRecipient.value || !recipientBlocked.value) return
  const { device_code, customer_id } = conversation
  issuingRecipient.value = true
  try {
    const { data } = await conversationsApi.issueRecipientRemark(device_code, customer_id)
    const current = activeConversation.value
    if (current?.device_code === device_code && current.customer_id === customer_id) {
      current.recipient_binding = data
    }
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '暂时无法生成会话备注')
  } finally {
    issuingRecipient.value = false
  }
}

/** 让客户端把备注码写进企微备注。指令走桥接队列，客户端点 UI 执行后回读确认。 */
async function applyRecipientRemark(): Promise<void> {
  const conversation = activeConversation.value
  const binding = recipientBinding.value
  if (!conversation || !binding?.remark || applyingRemark.value) return
  applyingRemark.value = true
  try {
    await conversationsApi.applyRecipientRemark(conversation.device_code, {
      name: String(conversation.nickname || conversation.name || ''),
      remark: binding.remark,
      conversation_id: String(conversation.external_conversation_id || ''),
    })
    ElMessage.success('已下发设置备注指令，客户端执行后自动核验')
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '指令下发失败')
  } finally {
    applyingRemark.value = false
  }
}

/* ---------- 发送 ---------- */
async function send(): Promise<void> {
  const device = activeDevice.value
  const conversation = activeConversation.value
  const content = draft.value.trim()
  if (!device || !conversation || !content || sending.value || recipientBlocked.value) return
  sending.value = true
  try {
    await conversationsApi.sendMessage(device.device_code, conversation.customer_id, content)
    draft.value = ''
    ElMessage.success('已发送')
    await loadMessages(true)
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '发送失败')
  } finally {
    sending.value = false
  }
}

/* ---------- 轮询 ---------- */
function startTimers(): void {
  stopTimers()
  convTimer = setInterval(() => {
    if (document.hidden) return
    if (activeDevice.value) void loadConversations(true)
  }, 10000)
  msgTimer = setInterval(() => {
    if (document.hidden || !activeConversation.value) return
    void loadMessages(false)
  }, 3000)
}

function stopTimers(): void {
  if (convTimer) {
    clearInterval(convTimer)
    convTimer = null
  }
  if (msgTimer) {
    clearInterval(msgTimer)
    msgTimer = null
  }
}

/* ---------- SSE 实时层（对齐 theme/realtime.js）：事件到达提前刷新，轮询兜底保留 ---------- */
const REFRESH_THROTTLE_MS = 300
let lastMessageRefresh = 0
let lastConvRefresh = 0

function throttledMessageRefresh(): void {
  const now = Date.now()
  if (now - lastMessageRefresh < REFRESH_THROTTLE_MS) return
  lastMessageRefresh = now
  void loadMessages(false)
}

function throttledConvRefresh(): void {
  const now = Date.now()
  if (now - lastConvRefresh < REFRESH_THROTTLE_MS) return
  lastConvRefresh = now
  void loadConversations(true)
  void loadUnreadCounts()
}

const stream = createAgentStream({
  onReady: () => throttledConvRefresh(),
  onMessageCreated: (payload) => {
    const message = payload?.message as { direction?: string } | undefined
    if (message?.direction === 'inbound' && activeConversation.value) {
      throttledMessageRefresh()
    }
    throttledConvRefresh()
  },
  onCommandUpdated: (payload) => {
    if (payload && payload.status === 'failed') {
      ElMessage.error(`发送失败：${String(payload.error || '设备未确认送达')}`)
    }
    throttledConvRefresh()
  },
  onDeviceUpdated: () => void loadDevices(),
})

onMounted(async () => {
  await loadDevices()
  startTimers()
  stream.start()
})

onBeforeUnmount(() => {
  stopTimers()
  stream.stop()
})
</script>

<style scoped>
.conv-page {
  height: calc(100vh - 120px);
}

.conv-container {
  display: flex;
  height: 100%;
  min-height: 520px;
  overflow: hidden;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.left-panel {
  display: flex;
  flex-direction: column;
  width: 230px;
  flex-shrink: 0;
  background: #fafafa;
  border-right: 1px solid #ebeef5;
  transition: width 0.18s ease;
}

.left-collapsed .left-panel {
  width: 0;
  border-right: 0;
  overflow: hidden;
}

.panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  padding: 10px 14px;
  border-bottom: 1px solid #ebeef5;
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}

.panel-title-wrap {
  flex-wrap: wrap;
  row-gap: 6px;
}

.mid-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.mid-actions {
  display: inline-flex;
  align-items: center;
}

.filter-row {
  display: flex;
  gap: 6px;
  align-items: center;
  width: 100%;
}

.filter-select {
  width: 96px;
  flex-shrink: 0;
}

.filter-daterange {
  flex: 1;
  min-width: 0;
}

.filter-daterange :deep(.el-range-input) {
  font-size: 11px;
}

.device-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.device-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.device-item:hover {
  background: #f0f2f5;
}

.device-item.active {
  background: #ecf5ff;
  color: #409eff;
}

.online-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #c0c4cc;
}

.online-dot.on {
  background: #67c23a;
}

.online-dot.off {
  background: #f56c6c;
}

.device-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  line-height: 1.35;
  white-space: normal;
  word-break: break-all;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.offline-tag {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 3px;
  background: #fef0f0;
  color: #f56c6c;
  font-size: 10px;
  line-height: 1.4;
}

.queue-indicator {
  flex-shrink: auto;
  padding: 1px 6px;
  border-radius: 10px;
  font-size: 11px;
  white-space: nowrap;
}

.queue-indicator.warn {
  background: #fff7e6;
  color: #fa8c16;
}

.device-badge {
  margin-left: auto;
}

.panel-error {
  margin: 8px 14px;
  color: var(--bd-danger);
  font-size: 12px;
}

.mid-panel {
  display: flex;
  flex-direction: column;
  width: 330px;
  flex-shrink: 0;
  border-right: 1px solid #ebeef5;
}

.customer-list {
  flex: 1;
  overflow-y: auto;
}

.panel-alert {
  margin: 8px 12px;
}

.customer-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid #f5f5f5;
  cursor: pointer;
  transition: background 0.15s;
}

.customer-item:hover {
  background: #f5f7fa;
}

.customer-item.active {
  background: #ecf5ff;
}

.customer-avatar-wrap {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
}

.state-icon {
  position: absolute;
  right: -2px;
  bottom: -2px;
  padding: 1px;
  border-radius: 50%;
  background: #fff;
  font-size: 16px;
}

.si-green {
  color: #67c23a;
}

.si-yellow {
  color: #e6a23c;
}

.si-gray {
  color: #c0c4cc;
}

.si-blue {
  color: #409eff;
}

.si-red {
  color: #f56c6c;
}

.customer-info {
  flex: 1;
  min-width: 0;
}

.customer-name {
  margin-bottom: 2px;
  overflow: hidden;
  font-size: 14px;
  color: #303133;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.customer-remark {
  display: inline-block;
  max-width: 110px;
  margin-left: 6px;
  padding: 1px 6px;
  overflow: hidden;
  border-radius: 4px;
  background: #f0f2f5;
  color: #606266;
  font-size: 12px;
  vertical-align: bottom;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.customer-sub-line {
  margin-top: 2px;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sub-name {
  margin-right: 8px;
  color: #303133;
  font-weight: 600;
}

.sub-phone {
  margin-right: 8px;
  color: #909399;
}

.sub-factory {
  margin-right: 8px;
  color: #409eff;
}

.sub-city {
  color: #67c23a;
}

.customer-msg {
  margin-top: 2px;
  overflow: hidden;
  color: #909399;
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.customer-time {
  flex-shrink: 0;
  align-self: flex-start;
  padding-top: 2px;
  color: #c0c4cc;
  font-size: 11px;
  white-space: nowrap;
}

.interview-badge {
  color: #67c23a;
  font-weight: 500;
}

.right-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.recipient-alert {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  margin: 8px 12px 0;
  padding: 10px 12px;
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: var(--el-border-radius-base);
  background: var(--el-color-warning-light-9);
  color: var(--el-text-color-primary);
  font-size: 13px;
}

.recipient-alert p {
  margin: 3px 0 0;
  line-height: 1.5;
}

.recipient-alert code {
  color: inherit;
  font-weight: 600;
  overflow-wrap: anywhere;
  user-select: all;
}

.chat-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  border-bottom: 1px solid #ebeef5;
  flex-wrap: wrap;
}

.chat-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
}

.chat-name {
  flex-shrink: 0;
  font-size: 15px;
  font-weight: 600;
}

.chat-nickname {
  margin-left: 4px;
  color: #c0c4cc;
  font-size: 12px;
  font-weight: 400;
}

.takeover-hint {
  font-size: 11px;
}

.chat-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.chat-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-input {
  padding: 10px 16px;
  border-top: 1px solid #ebeef5;
}

.input-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 6px;
}

@media (max-width: 1180px) {
  .left-panel {
    width: 190px;
  }

  .mid-panel {
    width: 300px;
  }

  .filter-row {
    flex-wrap: wrap;
  }

  .filter-select,
  .filter-daterange {
    flex: 1 1 100%;
    width: 100%;
  }

  .chat-name {
    max-width: 180px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}
</style>
