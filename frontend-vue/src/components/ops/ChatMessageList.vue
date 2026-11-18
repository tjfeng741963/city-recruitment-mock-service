<template>
  <div ref="container" class="chat-messages" v-loading="loading">
    <div v-if="hasMore" class="load-more">
      <el-button size="small" text type="primary" @click="loadMore">加载更早消息</el-button>
    </div>
    <template v-for="(message, index) in messages" :key="message.id">
      <div v-if="showDivider(index)" class="msg-time-divider">
        {{ formatDateTime(message.created_at) }}
      </div>
      <div class="msg-row" :class="message.role === 'customer' ? 'left' : 'right'">
        <div class="msg-bubble" :class="message.role">
          <template v-if="imageUrl(message)">
            <el-image
              v-if="mediaSrc(message)"
              :src="mediaSrc(message)"
              :preview-src-list="[mediaSrc(message)]"
              preview-teleported
              fit="contain"
              style="max-width: 220px; border-radius: 4px"
            />
            <div v-else class="msg-media-loading">图片加载中…</div>
          </template>
          <template v-else-if="fileUrl(message)">
            <el-link
              v-if="mediaSrc(message) || isDirect(fileUrl(message))"
              :href="mediaSrc(message) || fileUrl(message)"
              target="_blank"
              type="primary"
              style="font-size: 13px"
            >
              📎 附件
            </el-link>
            <div v-else class="msg-media-loading">附件加载中…</div>
          </template>
          <template v-else>
            <div class="msg-text">{{ message.content }}</div>
            <div v-if="message.status === 'failed'" class="msg-unsent">未发送（发送失败）</div>
            <div v-if="message.dedup_original" class="msg-original">原文：{{ message.dedup_original }}</div>
          </template>
        </div>
        <div class="msg-time">{{ shortTime(message.created_at) }}</div>
      </div>
    </template>
    <el-empty v-if="!loading && !messages.length" :description="emptyText" :image-size="90" />
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { formatDateTime } from '../../utils/format'
import { resolveAuthMedia, resolveAuthMediaBatch } from '../../utils/auth-media'
import type { AgentMessage } from '../../api/agent'

const props = withDefaults(
  defineProps<{
    messages: AgentMessage[]
    loading?: boolean
    hasMore?: boolean
    emptyText?: string
  }>(),
  { loading: false, hasMore: false, emptyText: '暂无消息' },
)

const emit = defineEmits<{ (event: 'loadMore'): void }>()

const container = ref<HTMLElement | null>(null)
let holdScroll = false

function isNearBottom(): boolean {
  const el = container.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120
}

function scrollToBottom(): void {
  nextTick(() => {
    const el = container.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function showDivider(index: number): boolean {
  if (index === 0) return true
  const current = new Date(props.messages[index].created_at).getTime()
  const previous = new Date(props.messages[index - 1].created_at).getTime()
  if (Number.isNaN(current) || Number.isNaN(previous)) return false
  return current - previous > 5 * 60 * 1000
}

function shortTime(value: string): string {
  if (!value) return ''
  const text = formatDateTime(value)
  return text.slice(11, 16)
}

// 需要鉴权的素材名 → blob objectURL；/uploads 等直接路径原样返回
const mediaUrls = ref<Record<string, string>>({})

function isDirect(value: string | null): boolean {
  return Boolean(value && (value.startsWith('/') || /^https?:\/\//.test(value)))
}

function mediaSrc(message: AgentMessage): string | null {
  const raw = imageUrl(message) || fileUrl(message)
  if (!raw) return null
  if (isDirect(raw)) return raw
  return mediaUrls.value[raw] || null
}

async function resolveMedia(): Promise<void> {
  const names = [
    ...new Set(
      props.messages
        .map((message) => imageUrl(message) || fileUrl(message) || '')
        .filter((value) => value && !isDirect(value)),
    ),
  ]
  await resolveAuthMediaBatch(names)
  const next: Record<string, string> = { ...mediaUrls.value }
  for (const name of names) {
    const resolved = await resolveAuthMedia(name)
    if (resolved) next[name] = resolved
  }
  mediaUrls.value = next
}

function imageUrl(message: AgentMessage): string | null {
  if (message.content_type === 'image') {
    const match = String(message.content || '').match(/（(.+?)）/)
    return match ? match[1] : String(message.content || '')
  }
  const match = String(message.content || '').trim().match(/^###图片（(.+?)）$/)
  return match ? match[1] : null
}

function fileUrl(message: AgentMessage): string | null {
  const match = String(message.content || '').trim().match(/^###文件（(.+?)）$/)
  return match ? match[1] : null
}

function loadMore(): void {
  const el = container.value
  if (!el) {
    emit('loadMore')
    return
  }
  const previousHeight = el.scrollHeight
  holdScroll = true
  emit('loadMore')
  nextTick(() => {
    const node = container.value
    if (node) node.scrollTop = node.scrollHeight - previousHeight
    holdScroll = false
  })
}

watch(
  () => props.messages.length,
  (_next, previous) => {
    if (holdScroll) return
    if (!previous) {
      scrollToBottom()
      return
    }
    if (isNearBottom()) scrollToBottom()
  },
)

defineExpose({ scrollToBottom })
</script>

<style scoped>
.chat-messages {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  background: #f5f6fa;
}

.load-more {
  text-align: center;
  margin-bottom: 8px;
}

.msg-time-divider {
  margin: 10px auto 14px;
  width: fit-content;
  padding: 2px 10px;
  border-radius: 10px;
  background: rgba(31, 31, 31, 0.08);
  color: #5e5e5e;
  font-size: 11px;
}

.msg-row {
  margin-bottom: 14px;
}

.msg-row.left {
  text-align: left;
}

.msg-row.right {
  text-align: right;
}

.msg-bubble {
  display: inline-block;
  max-width: 72%;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.55;
  word-break: break-word;
  text-align: left;
}

.msg-bubble.customer {
  background: #fff;
  color: #303133;
  border: 1px solid #ebeef5;
}

.msg-bubble.agent {
  background: #409eff;
  color: #fff;
}

.msg-text {
  white-space: pre-wrap;
}

.msg-unsent {
  margin-top: 4px;
  font-size: 11px;
  color: #ffd6d6;
  font-weight: 500;
}

.msg-original {
  margin-top: 4px;
  padding: 4px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.12);
  color: #dbeafe;
  font-size: 11px;
}

.msg-time {
  margin-top: 4px;
  font-size: 11px;
  color: #a8abb2;
}
</style>
