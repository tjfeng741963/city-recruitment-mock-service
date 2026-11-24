<template>
  <div class="position-context">
    <el-select v-model="selected" filterable clearable placeholder="选择招聘岗位" :loading="loading" :disabled="loading" aria-label="当前招聘岗位" @change="change">
      <el-option v-for="item in positions" :key="item.id" :value="item.id" :label="[item.city_name,item.position_name].filter(Boolean).join(' · ')" />
    </el-select>
    <span v-if="error" role="alert">{{ error }}</span>
    <span v-else-if="!selected" class="hint">先选岗位，流程、问答和素材会使用同一份招聘资料。</span>
    <template v-else>
      <nav class="position-links" aria-label="岗位接待页面">
        <template v-for="link in links" :key="link.path">
          <span v-if="route.path === link.path" class="position-link" aria-current="page">{{ link.label }}</span>
          <RouterLink v-else class="position-link" :to="positionLink(link.path, selected)">{{ link.label }}</RouterLink>
        </template>
      </nav>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { positionsApi } from '../../api/core'
import type { ServicePosition } from '../../api/types'
import { useAuthStore } from '../../stores/auth'
import { readPositionContext, savePositionContext } from '../../utils/position-context'
import { positionLink } from '../../layouts/navigation'
const route = useRoute(), router = useRouter(), auth = useAuthStore()
const emit = defineEmits<{ (event:'validated',id:number):void }>()
const selected = ref<number | undefined>(), positions = ref<ServicePosition[]>([]), loading = ref(true), error = ref('')
const links = [{path:'/recruitment-flow',label:'话术流程'},{path:'/knowledge',label:'问答知识库'},{path:'/media',label:'图片与视频'}]
const user = () => auth.user?.id ?? auth.user?.username ?? ''
async function change(value: unknown) {
  const id = Number(value) || 0
  error.value = ''
  emit('validated', id)
  savePositionContext(user(), id)
  await router.replace({ query: { ...route.query, position_id: id ? String(id) : undefined } })
}
onMounted(async () => {
  try {
    const {data} = await positionsApi.list({page:1,page_size:1000})
    positions.value = data.items || []
    const requested = Number(route.query.position_id) || readPositionContext(user())
    if (positions.value.some(item => item.id === requested)) { selected.value = requested; await change(requested) }
    else if (requested) {
      savePositionContext(user(),0)
      await router.replace({query:{...route.query,position_id:undefined}})
      error.value = '此前选择的岗位不存在或无权访问，请重新选择岗位。'
    }
  } catch { error.value = '岗位加载失败，请刷新重试。' }
  finally { loading.value = false; emit('validated', error.value ? -1 : (selected.value || 0)) }
})
watch(() => route.query.position_id, async raw => {
  const id=Number(raw)||0
  if (!loading.value && id && !positions.value.some(item=>item.id===id)) {
    selected.value=undefined;savePositionContext(user(),0)
    await router.replace({query:{...route.query,position_id:undefined}})
    error.value='岗位不存在或无权访问，请重新选择。'
    return
  }
  selected.value=id||undefined
})
</script>

<style scoped>
.position-context{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 16px;padding:12px;border:1px solid var(--bd-border);border-radius:8px;background:var(--el-bg-color)}
.position-context .el-select{width:300px;max-width:100%}.hint{font-size:12px;color:var(--bd-text-tertiary)}
.position-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.position-link {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 4px 12px;
  border: 1px solid var(--bd-border);
  border-radius: 8px;
  color: var(--rk-accent-deep);
  font-size: 14px;
  text-decoration: none;
}
a.position-link:hover {
  background: var(--el-fill-color-light);
}
a.position-link:focus-visible {
  outline: 2px solid var(--rk-accent);
  outline-offset: 2px;
}
.position-link[aria-current="page"] {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-5);
  font-weight: 600;
}
</style>
