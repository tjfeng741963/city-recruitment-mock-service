<template>
  <el-dialog
    :model-value="modelValue"
    title="重置登录密码"
    width="440px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="reset"
  >
    <p class="dialog-desc">
      为用户 <strong>{{ user?.username || '-' }}</strong> 设置新密码（后端要求至少 8 位）。
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
      <el-button type="primary" :loading="saving" @click="submit">确认重置</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { apiErrorMessage, usersApi, type UserItem } from '../../api/system'

const props = defineProps<{
  modelValue: boolean
  user: UserItem | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const formRef = ref<FormInstance>()
const saving = ref(false)
const form = reactive({ password: '', confirm: '' })

const rules: FormRules = {
  password: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 8, message: '密码至少 8 位', trigger: 'blur' },
  ],
  confirm: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule: unknown, value: string, callback: (error?: Error) => void) => {
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
  if (!valid || !props.user) return
  try {
    await ElMessageBox.confirm(
      `确定重置用户「${props.user.username}」的登录密码吗？重置后旧密码立即失效。`,
      '重置确认',
      { type: 'warning', confirmButtonText: '确认重置', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  saving.value = true
  try {
    await usersApi.resetPassword(props.user.id, form.password)
    ElMessage.success('密码已重置')
    emit('update:modelValue', false)
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '密码重置失败'))
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
