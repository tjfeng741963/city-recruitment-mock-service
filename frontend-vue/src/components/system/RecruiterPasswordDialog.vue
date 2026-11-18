<template>
  <el-dialog
    :model-value="modelValue"
    title="设置登录密码"
    width="440px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="reset"
  >
    <p class="dialog-desc">
      为招聘员
      <strong>{{ recruiterName || '-' }}</strong>
      设置新的登录密码（不会回显原密码）。
    </p>
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <el-form-item label="新密码" prop="password">
        <el-input
          v-model="form.password"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="请输入新密码"
        />
      </el-form-item>
      <el-form-item label="确认密码" prop="confirm">
        <el-input
          v-model="form.confirm"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="请再次输入新密码"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存密码</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { apiErrorMessage, recruitersApi } from '../../api/system'

const props = defineProps<{
  modelValue: boolean
  recruiterId: number | null
  recruiterName: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved'): void
}>()

const formRef = ref<FormInstance>()
const saving = ref(false)
const form = reactive({ password: '', confirm: '' })

const rules: FormRules = {
  password: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' },
  ],
  confirm: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value: string, callback) => {
        if (value !== form.password) callback(new Error('两次输入的密码不一致'))
        else callback()
      },
      trigger: 'blur',
    },
  ],
}

function reset(): void {
  form.password = ''
  form.confirm = ''
  formRef.value?.clearValidate()
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid || !props.recruiterId) return
  saving.value = true
  try {
    await recruitersApi.setPassword(props.recruiterId, form.password)
    ElMessage.success('登录密码已设置')
    emit('update:modelValue', false)
    emit('saved')
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '密码设置失败'))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.dialog-desc {
  margin: 0 0 16px;
  color: var(--bd-text-tertiary);
  font-size: 13px;
}

.dialog-desc strong {
  color: var(--bd-text-primary);
}
</style>
