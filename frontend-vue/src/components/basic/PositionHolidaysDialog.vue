<template>
  <el-dialog
    :model-value="modelValue"
    :title="`岗位节假日 · ${positionName}`"
    width="640px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="load"
  >
    <div class="toolbar">
      <span class="hint">共 {{ items.length }} 条节假日安排</span>
      <el-button type="primary" size="small" :icon="Plus" @click="openCreate">新增</el-button>
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="items" row-key="id" max-height="360">
        <template #empty>
          <el-empty description="该岗位暂无节假日安排" />
        </template>
        <el-table-column label="日期" width="150">
          <template #default="{ row }">{{ row.holiday_date || '-' }}</template>
        </el-table-column>
        <el-table-column prop="label" label="说明" min-width="180">
          <template #default="{ row }">
            <span>{{ row.label || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="isActive(row) ? 'success' : 'info'" effect="light">
              {{ isActive(row) ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog
      v-model="formVisible"
      :title="editingId ? '编辑节假日' : '新增节假日'"
      width="420px"
      append-to-body
      :close-on-click-modal="false"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="80px">
        <el-form-item label="日期" prop="holiday_date">
          <el-date-picker
            v-model="form.holiday_date"
            type="date"
            class="full"
            value-format="YYYY-MM-DD"
            placeholder="选择日期"
          />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.label" placeholder="如：春节放假" />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="form.is_active" active-text="启用" inactive-text="停用" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { positionsApi, apiErrorMessage } from '../../api/core'
import type { PositionHoliday } from '../../api/core'
import { toArray } from '../../utils/format'

const props = defineProps<{
  modelValue: boolean
  positionId: number | null
  positionName: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'changed'): void
}>()

const items = ref<PositionHoliday[]>([])
const loading = ref(false)
const saving = ref(false)
const formVisible = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

const form = reactive({ holiday_date: '', label: '', is_active: true })

const rules: FormRules = {
  holiday_date: [{ required: true, message: '请选择日期', trigger: 'change' }],
}

function isActive(row: PositionHoliday): boolean {
  if (typeof row.is_active === 'boolean') return row.is_active
  if (typeof row.is_active === 'number') return row.is_active === 1
  return true
}

async function load(): Promise<void> {
  if (!props.positionId) return
  loading.value = true
  try {
    const { data } = await positionsApi.holidays(props.positionId)
    items.value = toArray<PositionHoliday>(data)
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '节假日加载失败'))
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  editingId.value = null
  form.holiday_date = ''
  form.label = ''
  form.is_active = true
  formVisible.value = true
}

function openEdit(row: PositionHoliday): void {
  editingId.value = row.id
  form.holiday_date = row.holiday_date || ''
  form.label = String(row.label ?? '')
  form.is_active = isActive(row)
  formVisible.value = true
}

async function save(): Promise<void> {
  if (!formRef.value || !props.positionId) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const payload = {
      holiday_date: form.holiday_date,
      label: form.label,
      is_active: form.is_active,
      // 后端契约要求这四个业务字段（与旧前端一致），缺失会 422
      year: Number(form.holiday_date.slice(0, 4)) || new Date().getFullYear(),
      holiday_name: form.label || '节假日',
      start_date: form.holiday_date,
      end_date: form.holiday_date,
    }
    if (editingId.value) {
      await positionsApi.updateHoliday(props.positionId, editingId.value, payload)
      ElMessage.success('节假日已更新')
    } else {
      await positionsApi.addHoliday(props.positionId, payload)
      ElMessage.success('节假日已添加')
    }
    formVisible.value = false
    await load()
    emit('changed')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '保存失败'))
  } finally {
    saving.value = false
  }
}

async function remove(row: PositionHoliday): Promise<void> {
  if (!props.positionId) return
  try {
    await ElMessageBox.confirm(`确定删除 ${row.holiday_date} 的节假日记录吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await positionsApi.removeHoliday(props.positionId, row.id)
    ElMessage.success('节假日已删除')
    await load()
    emit('changed')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '删除失败'))
  }
}
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.hint {
  font-size: 12px;
  color: var(--bd-text-tertiary);
}

.full {
  width: 100%;
}
</style>
