<template>
  <el-drawer
    :model-value="modelValue"
    :title="title"
    size="620px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="reset"
  >
    <div v-loading="loading" class="drawer-body">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <div class="section-title">基础信息</div>
        <div class="grid-2">
          <el-form-item label="城市名称" prop="city_name">
            <el-input v-model="form.city_name" placeholder="如：深圳" maxlength="30" />
          </el-form-item>
          <el-form-item label="省份">
            <el-input v-model="form.province" placeholder="如：广东" maxlength="30" />
          </el-form-item>
        </div>

        <el-form-item v-if="mode === 'edit'" label="接待配置">
          <div class="status-line">
            <el-tag :type="statusTagType" effect="light"
              title="绑定已启用岗位后显示已配置；联机状态见微信账号">{{ statusText }}</el-tag>
          </div>
        </el-form-item>

        <el-form-item label="区域 / 区县（可多选/输入后回车新增）">
          <el-select
            v-model="form.districts"
            class="full"
            multiple
            filterable
            allow-create
            default-first-option
            :reserve-keyword="false"
            placeholder="如：福田区、罗湖区"
          >
            <el-option v-for="d in form.districts" :key="d" :label="d" :value="d" />
          </el-select>
        </el-form-item>

      </el-form>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="loading || !loaded" @click="submit">保存</el-button>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { citiesApi, apiErrorMessage } from '../../api/core'

type Mode = 'create' | 'edit'

const props = defineProps<{
  modelValue: boolean
  mode: Mode
  cityId?: number | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved'): void
}>()

const formRef = ref<FormInstance>()
const loading = ref(false)
const saving = ref(false)
const loaded = ref(false)
const receptionStatus = ref('inactive')
let loadSequence = 0
const form = reactive({ city_name: '', province: '', districts: [] as string[] })

const rules: FormRules = {
  city_name: [{ required: true, message: '请输入城市名称', trigger: 'blur' }],
}

const title = computed(() => props.mode === 'create' ? '添加城市' : '编辑城市')
const statusText = computed(() => receptionStatus.value === 'active' ? '已配置接待' : '未配置接待')
const statusTagType = computed(() => receptionStatus.value === 'active' ? 'success' : 'info')

async function reset(): Promise<void> {
  const sequence = ++loadSequence
  formRef.value?.clearValidate()
  Object.assign(form, { city_name: '', province: '', districts: [] })
  receptionStatus.value = 'inactive'
  loaded.value = props.mode === 'create'
  loading.value = false
  if (props.mode === 'create' || !props.cityId) return
  loading.value = true
  try {
    const { data } = await citiesApi.get(props.cityId)
    if (sequence !== loadSequence) return
    form.city_name = data.city_name
    form.province = String(data.province ?? '')
    form.districts = Array.isArray(data.districts) ? data.districts.filter(item => typeof item === 'string') : []
    receptionStatus.value = data.recruitment_status
    loaded.value = true
  } catch (error: unknown) {
    if (sequence === loadSequence) ElMessage.error(apiErrorMessage(error, '城市详情加载失败'))
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function submit(): Promise<void> {
  if (!formRef.value || !loaded.value || saving.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const payload = { city_name: form.city_name.trim(), province: form.province.trim(), districts: [...form.districts] }
    if (props.mode === 'edit' && props.cityId) {
      await citiesApi.updateBasics(props.cityId, payload)
      ElMessage.success('城市已保存')
    } else {
      await citiesApi.create(payload)
      ElMessage.success('城市已创建')
    }
    emit('update:modelValue', false)
    emit('saved')
  } catch (error: any) {
    const raw = String(apiErrorMessage(error, '保存失败'))
    const detail = raw.includes('UNIQUE constraint')
      ? `城市名称「${form.city_name}」已存在，请修改后再保存`
      : raw
    ElMessage.error(detail)
  } finally {
    saving.value = false
  }
}

</script>

<style scoped>
.drawer-body {
  padding-bottom: 8px;
}

.section-title {
  margin: 8px 0 14px;
  padding-left: 8px;
  border-left: 3px solid var(--bd-primary, #409eff);
  font-size: 14px;
  font-weight: 600;
  color: var(--bd-text-primary);
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
}

.full {
  width: 100%;
}

.status-line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

</style>
