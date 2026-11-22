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
            <el-tag :type="statusTagType" effect="light">{{ statusText }}</el-tag>
            <span class="hint">有已启用的设备绑定本城的已启用岗位时，显示「已配置接待」。设备在线情况可到微信账号查看。</span>
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

        <details :key="defaultSectionKey" class="city-defaults">
          <summary>城市默认资料</summary>
          <p class="hint">仅在同城岗位共用时填写。Dify 有对应城市资料时会优先使用，新建岗位也会用这些资料填充空白项。</p>
          <el-button v-if="mode === 'edit' && cityId" :disabled="loading" :data-city-default-materials="cityId">
            编辑完整城市原文资料
          </el-button>
          <div class="grid-2">
            <el-form-item label="面试点名称">
              <el-input v-model="form.interview_site_name" placeholder="如：深圳北站面试点" />
            </el-form-item>
            <el-form-item label="社保说明">
              <el-input v-model="form.social_insurances" placeholder="如：转正缴纳五险" />
            </el-form-item>
          </div>

          <div class="section-title">线路</div>
          <el-form-item label="主线路（可多选/输入后回车新增）">
            <el-select
              v-model="form.available_lines"
              class="full"
              multiple
              filterable
              allow-create
              default-first-option
              :reserve-keyword="false"
              placeholder="如：1号线、6号线"
            >
              <el-option v-for="line in form.available_lines" :key="line" :label="line" :value="line" />
            </el-select>
          </el-form-item>
          <div class="section-title">招聘配置</div>
          <div class="grid-3">
            <el-form-item label="流程类型">
              <el-select v-model="form.flow_type" class="full">
                <el-option label="标准流程" value="standard" />
                <el-option label="简化流程" value="simple" />
              </el-select>
            </el-form-item>
            <el-form-item label="工厂模式">
              <el-select v-model="form.factory_mode" class="full">
                <el-option label="不启用" value="none" />
                <el-option label="单工厂" value="single" />
                <el-option label="多工厂" value="multi" />
              </el-select>
            </el-form-item>
            <el-form-item label="男女住宿策略">
              <el-select v-model="form.gender_accommodation_policy" class="full">
                <el-option label="不区分" value="none" />
                <el-option label="男女同宿" value="same" />
                <el-option label="男女分宿" value="separate" />
              </el-select>
            </el-form-item>
          </div>
          <div class="grid-3">
            <el-form-item label="是否主推城市">
              <el-switch v-model="form.is_primary" />
            </el-form-item>
            <el-form-item label="是否询问住宿">
              <el-switch v-model="form.ask_accommodation" />
            </el-form-item>
            <el-form-item label="排序">
              <el-input-number v-model="form.sort_order" :min="0" :max="9999" class="full" />
            </el-form-item>
          </div>

          <div class="section-title">薪资与要求</div>
          <el-form-item label="薪资原文">
            <el-input v-model="form.salaryRaw" type="textarea" :rows="2" placeholder="如：综合月薪 5500-7000 元" />
          </el-form-item>
          <el-form-item label="工作时间">
            <el-input v-model="form.workHoursRaw" placeholder="如：8 小时三班倒" />
          </el-form-item>
          <el-form-item label="招聘要求">
            <el-input v-model="form.requirementsRaw" type="textarea" :rows="2" placeholder="如：18-35 岁，男女不限" />
          </el-form-item>

          <div class="section-title">面试信息</div>
          <div class="grid-2">
            <el-form-item label="面试时间">
              <el-input v-model="form.interviewTime" placeholder="如：每天 14:30" />
            </el-form-item>
            <el-form-item label="面试地点">
              <el-input v-model="form.interviewLocation" placeholder="如：福田区 XX 大厦" />
            </el-form-item>
          </div>
          <div class="grid-2">
            <el-form-item label="面试坐标">
              <el-input v-model="form.interviewCoordinates" placeholder="纬度,经度" />
            </el-form-item>
            <el-form-item label="签到码">
              <el-input v-model="form.interviewCheckInCode" />
            </el-form-item>
          </div>
          <el-form-item label="联系人">
            <el-input v-model="form.interviewContact" />
          </el-form-item>
          <el-form-item label="面试通知模板">
            <el-input v-model="form.interviewNotice" type="textarea" :rows="2" />
          </el-form-item>
          <el-form-item label="面试指引">
            <el-input v-model="form.interviewGuide" type="textarea" :rows="2" />
          </el-form-item>
        </details>
      </el-form>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="loading || (mode !== 'create' && !base.id)" @click="submit">保存</el-button>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { citiesApi, apiErrorMessage } from '../../api/core'
import type { City, CityPayload } from '../../api/core'

type Mode = 'create' | 'edit' | 'copy'

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
const base = ref<Record<string, unknown>>({})
const defaultSectionKey = ref(0)

const form = reactive({
  city_name: '',
  province: '',
  recruitment_status: 'inactive',
  interview_site_name: '',
  social_insurances: '',
  available_lines: [] as string[],
  districts: [] as string[],
  flow_type: 'standard',
  factory_mode: 'none',
  gender_accommodation_policy: 'none',
  is_primary: false,
  ask_accommodation: true,
  sort_order: 0,
  salaryRaw: '',
  workHoursRaw: '',
  requirementsRaw: '',
  interviewTime: '',
  interviewLocation: '',
  interviewCoordinates: '',
  interviewCheckInCode: '',
  interviewContact: '',
  interviewNotice: '',
  interviewGuide: '',
})

const rules: FormRules = {
  city_name: [{ required: true, message: '请输入城市名称', trigger: 'blur' }],
}

const title = computed(() => {
  if (props.mode === 'create') return '添加城市'
  if (props.mode === 'copy') return '复制城市'
  return '编辑城市'
})

const statusText = computed(() => (form.recruitment_status === 'active' ? '已配置接待' : '未配置接待'))
const statusTagType = computed(() => (form.recruitment_status === 'active' ? 'success' : 'info'))

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

function fill(source: Record<string, unknown>): void {
  form.city_name = String(source.city_name ?? '')
  form.province = String(source.province ?? '')
  form.recruitment_status = String(source.recruitment_status ?? 'inactive')
  form.interview_site_name = String(source.interview_site_name ?? '')
  form.social_insurances = String(source.social_insurances ?? '')
  form.available_lines = readStrings(source.available_lines)
  form.districts = readStrings(source.districts)
  form.flow_type = String(source.flow_type ?? 'standard')
  form.factory_mode = String(source.factory_mode ?? 'none')
  form.gender_accommodation_policy = String(source.gender_accommodation_policy ?? 'none')
  form.is_primary = Boolean(source.is_primary)
  form.ask_accommodation = source.ask_accommodation === undefined ? true : Boolean(source.ask_accommodation)
  form.sort_order = Number(source.sort_order ?? 0) || 0
  const salary = readObject(source.salary)
  form.salaryRaw = String(salary.raw ?? '')
  form.workHoursRaw = String(readObject(source.work_hours).raw ?? '')
  form.requirementsRaw = String(readObject(source.requirements).raw ?? '')
  const interview = readObject(source.interview)
  form.interviewTime = String(interview.time ?? '')
  form.interviewLocation = String(interview.location ?? '')
  form.interviewCoordinates = String(interview.coordinates ?? '')
  form.interviewCheckInCode = String(interview.check_in_code ?? '')
  form.interviewContact = String(interview.contact ?? '')
  form.interviewNotice = String(interview.interview_notice ?? '')
  form.interviewGuide = String(interview.interview_guide ?? '')
}

async function reset(): Promise<void> {
  defaultSectionKey.value += 1
  formRef.value?.clearValidate()
  base.value = {}
  fill({})
  if (props.mode === 'create') return
  if (!props.cityId) return
  loading.value = true
  try {
    const { data } = await citiesApi.get(props.cityId)
    base.value = data as unknown as Record<string, unknown>
    fill(base.value)
    if (props.mode === 'copy') form.city_name = `${form.city_name}（副本）`
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '城市详情加载失败'))
  } finally {
    loading.value = false
  }
}

function buildPayload(): Record<string, unknown> {
  const source = props.mode === 'edit' ? { ...base.value } : {}
  delete source.id
  delete source.created_at
  delete source.updated_at
  const salary = { ...readObject(source.salary), raw: form.salaryRaw }
  const interview = {
    ...readObject(source.interview),
    time: form.interviewTime,
    location: form.interviewLocation,
    coordinates: form.interviewCoordinates,
    check_in_code: form.interviewCheckInCode,
    contact: form.interviewContact,
    interview_notice: form.interviewNotice,
    interview_guide: form.interviewGuide,
  }
  return {
    ...source,
    city_name: form.city_name.trim(),
    province: form.province.trim(),
    recruitment_status: form.recruitment_status,
    interview_site_name: form.interview_site_name,
    social_insurances: form.social_insurances,
    available_lines: [...form.available_lines],
    districts: [...form.districts],
    flow_type: form.flow_type,
    factory_mode: form.factory_mode,
    gender_accommodation_policy: form.gender_accommodation_policy,
    is_primary: form.is_primary,
    ask_accommodation: form.ask_accommodation,
    sort_order: form.sort_order,
    salary,
    interview,
    work_hours: { ...readObject(source.work_hours), raw: form.workHoursRaw },
    requirements: { ...readObject(source.requirements), raw: form.requirementsRaw },
  }
}

async function submit(): Promise<void> {
  if (!formRef.value || (props.mode !== 'create' && !base.value.id)) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const payload = buildPayload()
    if (props.mode === 'edit' && props.cityId) {
      await citiesApi.update(props.cityId, payload as Partial<CityPayload>)
      ElMessage.success('城市已保存')
    } else {
      await citiesApi.create(payload as CityPayload)
      ElMessage.success(props.mode === 'copy' ? '城市副本已创建' : '城市已创建')
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

/** 供父组件在打开前预填（复制时可直接传入数据） */
function prefill(city: City): void {
  base.value = city as unknown as Record<string, unknown>
  fill(city as unknown as Record<string, unknown>)
  if (props.mode === 'copy') form.city_name = `${form.city_name}（副本）`
}

defineExpose({ prefill })
</script>

<style scoped>
.city-defaults { margin-top: 18px; border-top: 1px solid var(--el-border-color-light); }
.city-defaults summary { padding: 14px 0; font-weight: 600; cursor: pointer; }
.city-defaults .hint { margin: 0 0 10px; line-height: 1.6; }

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

.grid-3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
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

.hint {
  font-size: 12px;
  color: var(--bd-text-tertiary);
}
</style>
