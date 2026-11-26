<template>
  <div class="notification-group-select">
    <el-select
      :model-value="selected?.conv_id || (modelValue ? undefined : '')"
      :loading="loading"
      :disabled="!deviceCode"
      :placeholder="deviceCode ? '从已同步的企微群中选择' : '先保存并连接企微账号'"
      aria-label="报名通知群"
      filterable
      @visible-change="refreshOnOpen"
      @change="(value: string) => emit('update:modelValue', value)"
    >
      <el-option label="不发送群通知" value="" />
      <el-option v-for="group in groups" :key="group.conv_id" :label="group.name" :value="group.conv_id" :disabled="!group.selectable" />
    </el-select>
    <p v-if="message" class="form-hint" role="status">{{ message }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { devicesApi } from '../../api/agent'

const props = defineProps<{ deviceCode?: string; modelValue?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const groups = ref<Array<{ conv_id: string; name: string; selectable: boolean }>>([])
const loading = ref(false)
const failed = ref(false)
let request = 0

const selected = computed(() => groups.value.find(group => group.conv_id === props.modelValue && group.selectable))

const message = computed(() => {
  if (!props.deviceCode || loading.value) return ''
  if (failed.value) return '群列表读取失败，请重新打开下拉列表重试。'
  if (props.modelValue && !selected.value) {
    return props.modelValue.startsWith('R:')
      ? '已绑定的群不在同步列表，请重新选择。'
      : groups.value.some(group => group.name === props.modelValue && group.selectable)
        ? `请从同步列表重新选择「${props.modelValue}」，确认通知群。`
        : `已填写的「${props.modelValue}」无法核对，请从同步列表重新选择。`
  }
  return groups.value.some(group => group.selectable) ? '' : '此账号暂无可选的企微群，重新打开下拉列表可再次查询。'
})

async function refresh(): Promise<void> {
  const current = ++request
  const code = props.deviceCode
  loading.value = Boolean(code)
  failed.value = false
  if (!code) return
  try {
    const { data } = await devicesApi.groups(code)
    if (current === request) groups.value = data.items.flatMap(group =>
      group.conv_id?.startsWith('R:') && group.name ? [{ conv_id: group.conv_id, name: group.name, selectable: group.selectable === true }] : [])
  } catch {
    if (current === request) {
      groups.value = []
      failed.value = true
    }
  } finally {
    if (current === request) loading.value = false
  }
}

function refreshOnOpen(visible: boolean): void {
  if (visible && !loading.value) void refresh()
}

watch(() => props.deviceCode, () => {
  groups.value = []
  void refresh()
}, { immediate: true })
</script>

<style scoped>
.notification-group-select { width: 100%; min-width: 0; }
.notification-group-select .el-select { width: 100%; }
.form-hint { margin: 4px 0 0; color: var(--el-color-warning-dark-2); font-size: 12px; line-height: 1.5; }
</style>
