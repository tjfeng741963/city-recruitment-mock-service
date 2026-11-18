<template>
  <div class="mob-root">
    <header class="mob-header">
      <div class="mob-head-row">
        <div class="mob-title">
          <span class="mob-dot" :class="activeDevice && isOnline(activeDevice) ? 'on' : 'off'" />
          移动端对话
        </div>
        <span v-if="activeDevice" class="mob-device-name">{{ activeDevice.name || activeDevice.device_code }}</span>
      </div>
      <div class="mob-pickers">
        <el-select
          v-model="selectedDeviceId"
          size="small"
          placeholder="选择设备"
          :loading="devicesLoading"
          class="mob-select"
          @change="onDeviceChange"
        >
          <el-option
            v-for="device in devices"
            :key="device.id"
            :label="device.name || device.device_code"
            :value="device.id"
          />
        </el-select>
        <el-select
          v-model="selectedCustomerId"
          size="small"
          placeholder="选择客户"
          :loading="conversationsLoading"
          class="mob-select"
          :disabled="!conversations.length"
          @change="onCustomerChange"
        >
          <el-option
            v-for="conversation in conversations"
            :key="conversation.customer_id"
            :label="conversation.nickname || String(conversation.customer_id)"
            :value="conversation.customer_id"
          />
        </el-select>
      </div>
      <div v-if="activeConversation" class="mob-current">
        <span class="mob-current-name">
          {{ activeConversation.name || activeConversation.nickname || activeConversation.customer_id }}
        </span>
        <el-tag :type="statusTagType(activeConversation)" size="small" effect="light">
          {{ statusLabel(activeConversation) }}
        </el-tag>
      </div>
    </header>

    <el-alert
      v-if="error"
      class="mob-alert"
      type="error"
      :title="error"
      show-icon
      :closable="false"
    />

    <div ref="listRef" class="mob-messages" v-loading="messagesLoading">
      <template v-for="(message, index) in messages" :key="message.id">
        <div v-if="showDivider(index)" class="mob-divider">{{ formatDateTime(message.created_at) }}</div>
        <div class="mob-row" :class="message.role === 'customer' ? 'left' : 'right'">
          <div class="mob-bubble" :class="message.role">
            <span v-if="imageUrl(message)">
              <img v-if="mediaSrc(message)" :src="mediaSrc(message) || undefined" class="mob-image" alt="图片消息" />
              <span v-else class="mob-image-loading">图片加载中…</span>
            </span>
            <span v-else class="mob-text">{{ message.content }}</span>
          </div>
          <div class="mob-time">{{ formatDateTime(message.created_at).slice(11, 16) }}</div>
        </div>
      </template>
      <el-empty
        v-if="!messagesLoading && !messages.length"
        :description="conversations.length ? '暂无消息' : '暂无客户会话'"
        :image-size="80"
      />
    </div>

    <footer class="mob-input-bar">
      <el-input
        v-model="draft"
        type="textarea"
        :rows="2"
        resize="none"
        placeholder="输入消息..."
        class="mob-textarea"
        @keydown.ctrl.enter.prevent="send"
        @keydown.meta.enter.prevent="send"
      />
      <el-button
        type="primary"
        class="mob-send"
        :loading="sending"
        :disabled="!draft.trim() || !activeConversation"
        @click="send"
      >
        发送
      </el-button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  conversationsApi,
  devicesApi,
  type AgentConversation,
  type AgentDeviceItem,
  type AgentMessage,
} from '../api/agent'
import { formatDateTime } from '../utils/format'
import { resolveAuthMedia, resolveAuthMediaBatch } from '../utils/auth-media'

const devices = ref<AgentDeviceItem[]>([])
const conversations = ref<AgentConversation[]>([])
const messages = ref<AgentMessage[]>([])
const activeDevice = ref<AgentDeviceItem | null>(null)
const activeConversation = ref<AgentConversation | null>(null)
const selectedDeviceId = ref<number | null>(null)
const selectedCustomerId = ref<number | null>(null)
const devicesLoading = ref(false)
const conversationsLoading = ref(false)
const messagesLoading = ref(false)
const sending = ref(false)
const draft = ref('')
const error = ref('')
const listRef = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

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

function statusLabel(conversation: AgentConversation): string {
  const labels: Record<string, string> = {
    active: '进行中',
    pending_invite: '待邀约',
    invited: '已邀约',
    disqualified: '不符合',
    ai_abnormal: 'AI异常',
  }
  return labels[normalizeStatus(conversation)] || conversation.state || '进行中'
}

function statusTagType(conversation: AgentConversation): 'success' | 'warning' | 'danger' | 'info' {
  const status = normalizeStatus(conversation)
  if (status === 'invited') return 'success'
  if (status === 'pending_invite') return 'warning'
  if (status === 'disqualified' || status === 'ai_abnormal') return 'danger'
  return 'info'
}

function showDivider(index: number): boolean {
  if (index === 0) return true
  const current = new Date(messages.value[index].created_at).getTime()
  const previous = new Date(messages.value[index - 1].created_at).getTime()
  if (Number.isNaN(current) || Number.isNaN(previous)) return false
  return current - previous > 10 * 60 * 1000
}

function imageUrl(message: AgentMessage): string | null {
  const match = String(message.content || '').trim().match(/^###图片（(.+?)）$/)
  return match ? match[1] : null
}

const mediaUrls = ref<Record<string, string>>({})

function mediaSrc(message: AgentMessage): string | null {
  const raw = imageUrl(message)
  if (!raw) return null
  if (raw.startsWith('/') || /^https?:\/\//.test(raw)) return raw
  return mediaUrls.value[raw] || null
}

async function resolveMedia(): Promise<void> {
  const names = [
    ...new Set(messages.value.map((message) => imageUrl(message) || '').filter((value) => value && !/^[/h]/.test(value))),
  ]
  await resolveAuthMediaBatch(names)
  const next: Record<string, string> = { ...mediaUrls.value }
  for (const name of names) {
    const resolved = await resolveAuthMedia(name)
    if (resolved) next[name] = resolved
  }
  mediaUrls.value = next
}

function scrollToBottom(): void {
  nextTick(() => {
    const node = listRef.value
    if (node) node.scrollTop = node.scrollHeight
  })
}

async function loadDevices(): Promise<void> {
  devicesLoading.value = true
  error.value = ''
  try {
    const { data } = await devicesApi.list({ my: true, page: 1, page_size: 1000 })
    devices.value = data.items || []
    if (devices.value.length) {
      selectedDeviceId.value = devices.value[0].id
      await selectDevice(devices.value[0])
    }
  } catch (err: any) {
    error.value = err?.response?.data?.detail || '设备列表加载失败'
  } finally {
    devicesLoading.value = false
  }
}

async function selectDevice(device: AgentDeviceItem): Promise<void> {
  activeDevice.value = device
  activeConversation.value = null
  conversations.value = []
  messages.value = []
  selectedCustomerId.value = null
  await loadConversations()
}

async function loadConversations(): Promise<void> {
  const device = activeDevice.value
  if (!device) return
  conversationsLoading.value = true
  error.value = ''
  try {
    const { data } = await conversationsApi.list({
      device_code: device.device_code,
      page: 1,
      page_size: 1000,
    })
    conversations.value = data.items || []
    if (conversations.value.length) {
      const first = conversations.value[0]
      selectedCustomerId.value = first.customer_id
      await selectConversation(first)
    }
  } catch (err: any) {
    error.value = err?.response?.data?.detail || '会话列表加载失败'
  } finally {
    conversationsLoading.value = false
  }
}

async function selectConversation(conversation: AgentConversation): Promise<void> {
  activeConversation.value = conversation
  conversation.unread = 0
  await loadMessages()
}

async function loadMessages(): Promise<void> {
  const device = activeDevice.value
  const conversation = activeConversation.value
  if (!device || !conversation) return
  messagesLoading.value = true
  error.value = ''
  try {
    const { data } = await conversationsApi.messages({
      device_code: device.device_code,
      customer_id: conversation.customer_id,
      after_id: 0,
    })
    messages.value = [...(data.items || [])].sort((left, right) => left.id - right.id)
    void resolveMedia()
    scrollToBottom()
  } catch (err: any) {
    error.value = err?.response?.data?.detail || '消息加载失败'
  } finally {
    messagesLoading.value = false
  }
}

async function onDeviceChange(value: number): Promise<void> {
  const device = devices.value.find((item) => item.id === value)
  if (device) await selectDevice(device)
}

async function onCustomerChange(value: number): Promise<void> {
  const conversation = conversations.value.find((item) => item.customer_id === value)
  if (conversation) await selectConversation(conversation)
}

async function send(): Promise<void> {
  const device = activeDevice.value
  const conversation = activeConversation.value
  const content = draft.value.trim()
  if (!device || !conversation || !content || sending.value) return
  sending.value = true
  try {
    await conversationsApi.sendMessage(device.device_code, conversation.customer_id, content)
    draft.value = ''
    ElMessage.success('已发送')
    await loadMessages()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '发送失败')
  } finally {
    sending.value = false
  }
}

onMounted(async () => {
  await loadDevices()
  timer = setInterval(() => {
    if (!document.hidden && activeConversation.value) void loadMessages()
  }, 5000)
})

onBeforeUnmount(() => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
})
</script>

<style scoped>
.mob-root {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 100vw;
  overflow: hidden;
  background: #f5f6fa;
}

.mob-header {
  flex-shrink: 0;
  padding: 10px 12px 8px;
  padding-top: calc(10px + env(safe-area-inset-top));
  background: #fff;
  border-bottom: 1px solid #ebeef5;
}

.mob-head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.mob-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 16px;
  font-weight: 600;
  color: #1f2329;
  white-space: nowrap;
}

.mob-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #c0c4cc;
  flex-shrink: 0;
}

.mob-dot.on {
  background: #67c23a;
}

.mob-dot.off {
  background: #f56c6c;
}

.mob-device-name {
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  color: #8f959e;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.mob-pickers {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
  margin-top: 8px;
}

.mob-select {
  width: 100%;
  min-width: 0;
}

.mob-current {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-top: 8px;
}

.mob-current-name {
  overflow: hidden;
  font-size: 13px;
  color: #646a73;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.mob-alert {
  flex-shrink: 0;
  margin: 8px 12px 0;
}

.mob-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px;
  -webkit-overflow-scrolling: touch;
}

.mob-divider {
  width: fit-content;
  margin: 8px auto 10px;
  padding: 2px 10px;
  border-radius: 10px;
  background: rgba(31, 31, 31, 0.08);
  color: #5e5e5e;
  font-size: 11px;
}

.mob-row {
  margin-bottom: 10px;
  max-width: 100%;
}

.mob-row.left {
  text-align: left;
}

.mob-row.right {
  text-align: right;
}

.mob-bubble {
  display: inline-block;
  max-width: 80%;
  padding: 9px 12px;
  border-radius: 10px;
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
  text-align: left;
}

.mob-bubble.customer {
  background: #fff;
  color: #1f2329;
  border: 1px solid #ebeef5;
}

.mob-bubble.agent {
  background: #3370ff;
  color: #fff;
}

.mob-text {
  white-space: pre-wrap;
}

.mob-image {
  display: block;
  max-width: 200px;
  max-height: 200px;
  border-radius: 6px;
}

.mob-time {
  margin-top: 3px;
  font-size: 11px;
  color: #a8abb2;
}

.mob-input-bar {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 10px;
  padding-bottom: calc(8px + env(safe-area-inset-bottom));
  background: #fff;
  border-top: 1px solid #ebeef5;
}

.mob-textarea {
  flex: 1;
  min-width: 0;
}

.mob-textarea :deep(textarea) {
  font-size: 14px;
}

.mob-send {
  flex-shrink: 0;
  height: 40px;
}
</style>
