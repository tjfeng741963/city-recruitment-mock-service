<template>
  <el-dialog
    :model-value="modelValue"
    :title="mode === 'create' ? '添加招聘员' : '编辑招聘员'"
    width="640px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="init"
  >
    <div v-loading="loading">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <div class="grid-2">
          <el-form-item label="招聘员 ID" prop="recruiter_id">
            <el-input v-model="form.recruiter_id" placeholder="如：mock-recruiter" maxlength="64" />
          </el-form-item>
          <el-form-item label="姓名" prop="name">
            <el-input v-model="form.name" placeholder="如：示例招聘员" maxlength="64" />
          </el-form-item>
        </div>

        <el-form-item label="描述">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="2"
            placeholder="备注说明（可选）"
          />
        </el-form-item>

        <div class="grid-3">
          <el-form-item label="类型">
            <el-select v-model="form.recruiter_type" class="full">
              <el-option
                v-for="item in recruiterTypes"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="状态">
            <el-switch
              v-model="form.is_active"
              inline-prompt
              active-text="启用"
              inactive-text="停用"
            />
          </el-form-item>
          <el-form-item label="排序">
            <el-input-number v-model="form.sort_order" :min="0" :max="9999" class="full" />
          </el-form-item>
        </div>

        <el-collapse v-model="openedPanels">
          <el-collapse-item name="llm" title="LLM 配置（JSON，可选）">
            <el-input
              v-model="llmConfigText"
              type="textarea"
              :rows="6"
              placeholder='例如：{"model": "gpt-4o-mini", "temperature": 0.3}'
              class="code-input"
            />
            <div class="hint">填写 JSON，或留空。</div>
          </el-collapse-item>
        </el-collapse>
      </el-form>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">
        {{ mode === 'create' ? '创建' : '保存' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { apiErrorMessage, recruiterTypes, recruitersApi } from '../../api/system'
import type { RecruiterPayload } from '../../api/system'

const props = defineProps<{
  modelValue: boolean
  mode: 'create' | 'edit'
  recruiterId: number | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved'): void
}>()

const formRef = ref<FormInstance>()
const loading = ref(false)
const saving = ref(false)
const llmConfigText = ref('')
const openedPanels = ref<string[]>([])

const form = reactive({
  recruiter_id: '',
  name: '',
  description: '',
  recruiter_type: 'service',
  is_active: true,
  sort_order: 0,
})

const rules: FormRules = {
  recruiter_id: [{ required: true, message: '请输入招聘员 ID', trigger: 'blur' }],
  name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
}

function resetForm(): void {
  form.recruiter_id = ''
  form.name = ''
  form.description = ''
  form.recruiter_type = 'service'
  form.is_active = true
  form.sort_order = 0
  llmConfigText.value = ''
  openedPanels.value = []
  formRef.value?.clearValidate()
}

async function init(): Promise<void> {
  resetForm()
  if (props.mode !== 'edit' || !props.recruiterId) return
  loading.value = true
  try {
    const { data } = await recruitersApi.get(props.recruiterId)
    form.recruiter_id = data.recruiter_id || ''
    form.name = data.name || ''
    form.description = data.description || ''
    form.recruiter_type = data.recruiter_type || 'service'
    form.is_active = data.is_active !== false
    form.sort_order = Number(data.sort_order ?? 0)
    const config = data.llm_config
    llmConfigText.value =
      config && Object.keys(config).length ? JSON.stringify(config, null, 2) : ''
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '招聘员详情加载失败'))
  } finally {
    loading.value = false
  }
}

function parseLlmConfig(): Record<string, unknown> {
  const text = llmConfigText.value.trim()
  if (!text) return {}
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM 配置必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  let llmConfig: Record<string, unknown>
  try {
    llmConfig = parseLlmConfig()
  } catch {
    ElMessage.error('LLM 配置不是合法的 JSON 对象')
    openedPanels.value = ['llm']
    return
  }

  const payload: RecruiterPayload = {
    recruiter_id: form.recruiter_id.trim(),
    name: form.name.trim(),
    description: form.description,
    recruiter_type: form.recruiter_type,
    is_active: form.is_active,
    sort_order: form.sort_order,
    llm_config: llmConfig,
  }

  saving.value = true
  try {
    if (props.mode === 'create') {
      await recruitersApi.create(payload)
      ElMessage.success('招聘员已创建')
    } else if (props.recruiterId) {
      await recruitersApi.update(props.recruiterId, payload)
      ElMessage.success('招聘员已更新')
    }
    emit('update:modelValue', false)
    emit('saved')
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '保存失败'))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
}

.grid-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 16px;
}

.full {
  width: 100%;
}

.hint {
  margin-top: 6px;
  color: var(--bd-text-tertiary);
  font-size: 12px;
}

.code-input :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
}
</style>
