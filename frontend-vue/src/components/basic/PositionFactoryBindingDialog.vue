<template>
  <el-dialog
    :model-value="modelValue"
    :title="`厂区绑定 · ${positionName}`"
    width="520px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="load"
  >
    <div v-loading="loading">
      <el-descriptions v-if="binding" :column="1" border size="small" class="summary">
        <el-descriptions-item label="所属城市">{{ binding.city_name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="当前工厂">{{ binding.factory_name || '未绑定' }}</el-descriptions-item>
      </el-descriptions>

      <el-form label-width="90px" class="form">
        <el-form-item label="绑定工厂">
          <el-select v-model="factoryId" class="full" clearable placeholder="不绑定工厂">
            <el-option
              v-for="factory in factories"
              :key="factory.id"
              :label="factory.factory_name"
              :value="factory.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <p class="hint">清空后取消工厂归属。</p>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!binding" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { positionsApi, apiErrorMessage } from '../../api/core'
import type { Factory } from '../../api/core'

const props = defineProps<{
  modelValue: boolean
  positionId: number | null
  positionName: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved'): void
}>()

const loading = ref(false)
const saving = ref(false)
const factoryId = ref<number | null>(null)
const factories = ref<Factory[]>([])
const binding = ref<Record<string, unknown> | null>(null)

async function load(): Promise<void> {
  if (!props.positionId) return
  loading.value = true
  binding.value = null
  try {
    const { data } = await positionsApi.bindingGet(props.positionId)
    binding.value = data
    factoryId.value = typeof data.factory_id === 'number' ? data.factory_id : null
    factories.value = Array.isArray(data.factories) ? (data.factories as Factory[]) : []
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '绑定信息加载失败'))
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (!props.positionId) return
  saving.value = true
  try {
    await positionsApi.bindingPut(props.positionId, { factory_id: factoryId.value })
    ElMessage.success('厂区绑定已保存')
    emit('update:modelValue', false)
    emit('saved')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '绑定失败'))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.summary {
  margin-bottom: 16px;
}

.form {
  margin-top: 4px;
}

.full {
  width: 100%;
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--bd-text-tertiary);
}
</style>
