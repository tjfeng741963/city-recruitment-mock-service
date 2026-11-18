<template>
  <div class="api-missing" :class="{ 'is-compact': compact }" role="status">
    <div class="api-missing-icon">!</div>
    <div class="api-missing-body">
      <div class="api-missing-title">{{ title }}</div>
      <div class="api-missing-desc">{{ resolvedDescription }}</div>
      <code class="api-missing-path">{{ api }}</code>
      <div v-if="hint" class="api-missing-hint">{{ hint }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 缺失的接口路径，必须原样展示给使用者 */
    api: string
    title?: string
    description?: string
    hint?: string
    compact?: boolean
  }>(),
  {
    title: '接口未提供',
    description: '',
    hint: '',
    compact: false,
  },
)

const resolvedDescription = computed(
  () => props.description || `后端未提供 ${props.api}`,
)
</script>

<style scoped>
.api-missing {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  width: 100%;
  padding: 16px 18px;
  border: 1px dashed rgba(161, 79, 0, 0.32);
  border-radius: 14px;
  background: rgba(255, 248, 232, 0.66);
  color: #7a4b00;
  text-align: left;
}

.api-missing.is-compact {
  padding: 10px 12px;
  gap: 10px;
}

.api-missing-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: 50%;
  background: #e6a23c;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}

.api-missing-body {
  min-width: 0;
}

.api-missing-title {
  font-size: 13px;
  font-weight: 600;
  color: #7a4b00;
}

.api-missing-desc {
  margin-top: 3px;
  font-size: 12.5px;
  line-height: 1.6;
  color: #8a5b00;
  word-break: break-word;
}

.api-missing-path {
  display: inline-block;
  max-width: 100%;
  margin-top: 6px;
  padding: 1px 7px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.72);
  color: #8a5b00;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.7;
  word-break: break-all;
}

.api-missing-hint {
  margin-top: 6px;
  font-size: 12px;
  color: #9a6a12;
  line-height: 1.6;
}
</style>
