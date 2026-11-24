<template>
  <el-dialog
    :model-value="modelValue"
    :title="`区域设置 · ${cityName}`"
    width="500px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="reset"
  >
    <el-select
      v-model="local"
      class="full"
      multiple
      filterable
      allow-create
      default-first-option
      :reserve-keyword="false"
      placeholder="输入区县，按回车添加"
    >
      <el-option v-for="item in local" :key="item" :label="item" :value="item" />
    </el-select>
    <p class="hint">共 {{ local.length }} 个区县</p>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="save">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  modelValue: boolean
  cityName: string
  districts: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'save', districts: string[]): void
}>()

const local = ref<string[]>([])

function reset(): void {
  local.value = [...props.districts]
}

function save(): void {
  emit('save', [...new Set(local.value.map((item) => item.trim()).filter(Boolean))])
  emit('update:modelValue', false)
}
</script>

<style scoped>
.full {
  width: 100%;
}

.hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--bd-text-tertiary);
}
</style>
