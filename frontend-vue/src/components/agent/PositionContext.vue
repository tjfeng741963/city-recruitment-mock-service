<template>
  <div class="position-context">
    <label class="position-filter-label" for="reception-position-filter">按岗位筛选</label>
    <el-select id="reception-position-filter" v-model="selected" filterable clearable placeholder="全部岗位" :loading="loading" :disabled="loading" @change="change">
      <el-option v-for="item in positions" :key="item.id" :value="item.id" :label="positionOptionLabel(item)" />
    </el-select>
    <span v-if="error" role="alert">{{ error }}</span>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { positionsApi } from '../../api/core'
import type { ServicePosition } from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import { positionOptionLabel, readPositionContext, savePositionContext } from '../../utils/position-context'
const route = useRoute(), router = useRouter(), auth = useAuthStore()
const emit = defineEmits<{ validated: [id: number]; positions: [items: ServicePosition[]] }>()
const selected = ref<number | undefined>(), positions = ref<ServicePosition[]>([]), loading = ref(true), error = ref('')
const user = () => auth.user?.id ?? auth.user?.username ?? ''
let disposed = false

async function change(value: unknown) {
  const id = Number(value) || 0
  error.value = ''
  emit('validated', id)
  savePositionContext(user(), id)
  await router.replace({ query: { ...route.query, position_id: id ? String(id) : undefined } })
}

onMounted(async () => {
  try {
    const { data } = await positionsApi.list({ page: 1, page_size: 1000 })
    if (disposed) return
    positions.value = data.items || []
    const explicit = route.query.position_id
    const requested = explicit === undefined ? readPositionContext(user()) : Number(explicit)
    if (positions.value.some(item => item.id === requested)) {
      selected.value = requested
      savePositionContext(user(), requested)
    } else if (explicit !== undefined || requested) {
      if (explicit === undefined) savePositionContext(user(), 0)
      error.value = '此前选择的岗位不存在或无权访问，请重新选择岗位。'
    }
  } catch {
    error.value = '岗位加载失败，请刷新重试。'
  } finally {
    if (!disposed) {
      loading.value = false
      emit('positions', positions.value)
      emit('validated', error.value ? -1 : (selected.value ?? 0))
    }
  }
})

onBeforeUnmount(() => { disposed = true })
</script>

<style scoped>
.position-context{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 16px;padding:12px;border:1px solid var(--bd-border);border-radius:8px;background:var(--el-bg-color)}
.position-context .el-select { width: 300px; max-width: 100%; }
.position-filter-label { font-size: 13px; font-weight: 600; color: var(--bd-text-primary); }
</style>
