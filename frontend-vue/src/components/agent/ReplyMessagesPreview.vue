<template>
  <div class="reply-messages">
    <template v-for="(message, index) in messages" :key="index">
      <FlowMediaPreview v-if="message.name && (message.type === 'image' || message.type === 'video')"
        :name="message.name" :kind="message.type" :label="message.content" />
      <p v-else-if="message.content || message.name">{{ message.content || message.name }}</p>
    </template>
  </div>
</template>

<script lang="ts">
export interface ReplyPreviewMessage {
  type?: string
  name?: string
  content?: string
}
</script>

<script setup lang="ts">
import FlowMediaPreview from './FlowMediaPreview.vue'

defineProps<{ messages: ReplyPreviewMessage[] }>()
</script>

<style scoped>
.reply-messages { display: grid; gap: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.reply-messages p { margin: 0; }
</style>
