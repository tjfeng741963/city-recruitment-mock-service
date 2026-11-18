<template>
  <el-drawer
    :model-value="modelValue"
    :title="`厂区管理 · ${cityName}`"
    size="720px"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="load"
  >
    <div class="drawer-toolbar">
      <span class="hint">该城市下共 {{ factories.length }} 个厂区</span>
      <div class="toolbar-actions">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增厂区</el-button>
      </div>
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="factories" row-key="id" empty-text="该城市暂无厂区">
        <template #empty>
          <el-empty description="该城市暂无厂区" />
        </template>
        <el-table-column prop="factory_name" label="厂区名称" min-width="180" />
        <el-table-column prop="address" label="地址" min-width="180">
          <template #default="{ row }">
            <span class="muted">{{ row.address || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="contact" label="联系人" width="120">
          <template #default="{ row }">
            <span class="muted">{{ row.contact || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.is_active ? 'success' : 'info'" effect="light">
              {{ row.is_active ? '启用' : '停用' }}
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
      v-model="dialogVisible"
      :title="editingId ? '编辑厂区' : '新增厂区'"
      width="460px"
      append-to-body
      :close-on-click-modal="false"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="厂区名称" prop="factory_name">
          <el-input v-model="form.factory_name" placeholder="如：深圳地铁安检基地" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="form.address" placeholder="厂区详细地址" />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="form.contact" placeholder="联系人 / 电话" />
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="form.is_active" active-text="启用" inactive-text="停用" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { Plus, Refresh } from '@element-plus/icons-vue'
import { factoriesApi, apiErrorMessage } from '../../api/core'
import type { Factory } from '../../api/core'
import { toArray } from '../../utils/format'

const props = defineProps<{
  modelValue: boolean
  cityId: number | null
  cityName: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'changed'): void
}>()

const factories = ref<Factory[]>([])
const loading = ref(false)
const saving = ref(false)
const dialogVisible = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

const form = reactive({
  factory_name: '',
  address: '',
  contact: '',
  is_active: true,
})

const rules: FormRules = { factory_name: [{ required: true, message: '请输入厂区名称', trigger: 'blur' }] }

const cityName = computed(() => props.cityName || '-')

async function load(): Promise<void> {
  if (!props.cityId) return
  loading.value = true
  try {
    const { data } = await factoriesApi.byCity(props.cityId)
    factories.value = toArray<Factory>(data)
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '厂区列表加载失败'))
  } finally {
    loading.value = false
  }
}

function resetForm(): void {
  form.factory_name = ''
  form.address = ''
  form.contact = ''
  form.is_active = true
}

function openCreate(): void {
  editingId.value = null
  resetForm()
  dialogVisible.value = true
}

function openEdit(row: Factory): void {
  editingId.value = row.id
  form.factory_name = row.factory_name
  form.address = String(row.address ?? '')
  form.contact = String(row.contact ?? '')
  form.is_active = row.is_active !== false
  dialogVisible.value = true
}

async function save(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const payload = {
      factory_name: form.factory_name.trim(),
      address: form.address,
      contact: form.contact,
      is_active: form.is_active,
      city_id: props.cityId ?? undefined,
    }
    if (editingId.value) {
      await factoriesApi.update(editingId.value, payload)
      ElMessage.success('厂区已保存')
    } else {
      await factoriesApi.create(payload)
      ElMessage.success('厂区已创建')
    }
    dialogVisible.value = false
    await load()
    emit('changed')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '保存失败'))
  } finally {
    saving.value = false
  }
}

async function remove(row: Factory): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除厂区「${row.factory_name}」吗？该操作不可撤销。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await factoriesApi.remove(row.id)
    ElMessage.success('厂区已删除')
    await load()
    emit('changed')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '删除失败'))
  }
}

defineExpose({ load })
</script>

<style scoped>
.drawer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.toolbar-actions {
  display: flex;
  gap: 8px;
}

.hint {
  font-size: 12px;
  color: var(--bd-text-tertiary);
}
</style>
