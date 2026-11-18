<template>
  <el-dialog
    :model-value="modelValue"
    :title="mode === 'create' ? '添加用户' : '编辑用户'"
    width="520px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="reset"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
      <el-form-item label="用户名" prop="username">
        <el-input
          v-model="form.username"
          :disabled="mode === 'edit'"
          placeholder="请输入用户名"
          maxlength="64"
        />
      </el-form-item>

      <el-form-item v-if="mode === 'create'" label="初始密码" prop="password">
        <el-input
          v-model="form.password"
          type="password"
          show-password
          autocomplete="new-password"
          placeholder="至少 8 位"
        />
      </el-form-item>

      <el-form-item label="角色" prop="role">
        <el-select v-model="form.role" class="full">
          <el-option
            v-for="item in userRoles"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="招聘员 ID" prop="recruiter_id">
        <el-select
          v-model="form.recruiter_id"
          class="full"
          filterable
          clearable
          :placeholder="form.role === 'admin' ? '管理员可不绑定招聘员' : '请选择招聘员'"
        >
          <el-option
            v-for="item in recruiters"
            :key="item.id"
            :label="`${item.name}（${item.recruiter_id}）`"
            :value="item.recruiter_id"
          />
        </el-select>
        <div class="hint">
          {{ form.role === 'admin' ? '管理员可留空。' : '客户 / 招聘员账号必须绑定招聘员。' }}
        </div>
      </el-form-item>

      <el-alert
        v-if="mode === 'edit' && isSelf"
        title="不能修改当前登录账号的角色，也不能停用自己的管理员账号。"
        type="info"
        show-icon
        :closable="false"
      />
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">
        {{ mode === 'create' ? '创建' : '保存' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { apiErrorMessage, userRoles, usersApi } from '../../api/system'
import type { UserItem, UserPayload } from '../../api/system'
import type { Recruiter } from '../../api/types'

const props = defineProps<{
  modelValue: boolean
  mode: 'create' | 'edit'
  user: UserItem | null
  recruiters: Recruiter[]
  currentUsername: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved'): void
}>()

const formRef = ref<FormInstance>()
const saving = ref(false)
const form = reactive({
  username: '',
  password: '',
  role: 'customer',
  recruiter_id: '',
})

const isSelf = computed(() => props.mode === 'edit' && props.user?.username === props.currentUsername)

const rules = computed<FormRules>(() => ({
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  ...(props.mode === 'create'
    ? {
        password: [
          { required: true, message: '请输入初始密码', trigger: 'blur' },
          { min: 8, message: '密码至少 8 位', trigger: 'blur' },
        ],
      }
    : {}),
  role: [{ required: true, message: '请选择角色', trigger: 'change' }],
  recruiter_id: [
    {
      validator: (_rule: unknown, value: string, callback: (error?: Error) => void) => {
        if (form.role !== 'admin' && !value) callback(new Error('客户 / 招聘员账号必须绑定招聘员'))
        else callback()
      },
      trigger: 'change',
    },
  ],
}))

function reset(): void {
  form.username = props.mode === 'edit' ? props.user?.username || '' : ''
  form.password = ''
  form.role = props.user?.role || 'customer'
  form.recruiter_id = props.user?.recruiter_id || ''
  formRef.value?.clearValidate()
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    if (props.mode === 'create') {
      const payload: UserPayload = {
        username: form.username.trim(),
        password: form.password,
        role: form.role,
        recruiter_id: form.recruiter_id || '',
      }
      await usersApi.create(payload)
      ElMessage.success('用户已创建')
    } else if (props.user) {
      await usersApi.update(props.user.id, {
        role: form.role,
        recruiter_id: form.recruiter_id || '',
        recruiter_type: props.user.recruiter_type || '',
      })
      ElMessage.success('用户已更新')
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
.full {
  width: 100%;
}

.hint {
  margin-top: 4px;
  color: var(--bd-text-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
</style>
