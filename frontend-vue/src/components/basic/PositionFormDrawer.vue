<template>
  <el-drawer
    :model-value="modelValue"
    :title="title"
    size="880px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="reset"
  >
    <div v-loading="loading" class="drawer-body">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top">
        <el-tabs v-model="activeTab">
          <el-tab-pane label="基础信息" name="base">
            <div class="grid-2">
              <el-form-item label="岗位名称" prop="position_name">
                <el-input v-model="form.position_name" placeholder="如：深圳_地铁安检员" />
              </el-form-item>
              <el-form-item label="所属城市" prop="city_id">
                <el-select
                  v-model="form.city_id"
                  class="full"
                  filterable
                  placeholder="请选择城市"
                  @change="onCityChange"
                >
                  <el-option v-for="city in cities" :key="city.id" :label="city.city_name" :value="city.id" />
                </el-select>
              </el-form-item>
            </div>

            <div class="grid-2">
              <el-form-item label="绑定工厂">
                <el-select v-model="form.factory_id" class="full" clearable placeholder="不绑定工厂">
                  <el-option
                    v-for="factory in cityFactories"
                    :key="factory.id"
                    :label="factory.factory_name"
                    :value="factory.id"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="招聘员 ID">
                <el-input v-model="form.recruiter_id" placeholder="留空表示不限" />
              </el-form-item>
            </div>

            <div class="grid-3">
              <el-form-item label="性别要求">
                <el-select v-model="form.gender" class="full" allow-create filterable>
                  <el-option label="不限" value="不限" />
                  <el-option label="男" value="男" />
                  <el-option label="女" value="女" />
                  <el-option label="男女不限" value="男女不限" />
                </el-select>
              </el-form-item>
              <el-form-item label="年龄要求">
                <el-input v-model="form.age_range" placeholder="如：18-35岁" />
              </el-form-item>
              <el-form-item label="身高要求">
                <el-input v-model="form.height_require" placeholder="如：男 170cm 以上" />
              </el-form-item>
            </div>

            <div class="grid-3">
              <el-form-item label="工作类型">
                <el-select v-model="form.job_type" class="full" allow-create filterable>
                  <el-option label="全职" value="全职" />
                  <el-option label="兼职" value="兼职" />
                  <el-option label="实习" value="实习" />
                </el-select>
              </el-form-item>
              <el-form-item label="住宿情况">
                <el-input v-model="form.accommodation" placeholder="如：包吃住" />
              </el-form-item>
              <el-form-item label="健康证">
                <el-input v-model="form.health_cert" placeholder="如：需要健康证" />
              </el-form-item>
            </div>

            <div class="grid-3">
              <el-form-item label="经验要求">
                <el-input v-model="form.experience" placeholder="如：不限 / 1 年以上" />
              </el-form-item>
              <el-form-item label="区域">
                <el-input v-model="form.district" placeholder="如：福田区" />
              </el-form-item>
              <el-form-item label="是否启用">
                <el-switch v-model="form.is_active" active-text="启用" inactive-text="停用" />
              </el-form-item>
            </div>
          </el-tab-pane>

          <el-tab-pane label="岗位资料" name="sections">
            <p class="tab-tip">以下文本段用于 Agent 与岗位详情展示，按分组填写。</p>
            <el-collapse v-model="openGroups">
              <el-collapse-item
                v-for="group in sectionGroups"
                :key="group.key"
                :title="group.title"
                :name="group.key"
              >
                <el-form-item v-for="key in group.keys" :key="key" :label="sectionLabel(key)">
                  <el-input
                    v-model="form.sections[key]"
                    type="textarea"
                    :rows="key === 'interview_notice' || key === 'checkin_guide' ? 4 : 2"
                    :placeholder="`${sectionLabel(key)}，留空表示不启用该段`"
                  />
                </el-form-item>
              </el-collapse-item>
            </el-collapse>
          </el-tab-pane>

          <el-tab-pane label="面试与门店" name="interview">
            <div class="grid-2">
              <el-form-item label="面试时间">
                <el-input v-model="form.interview_time" placeholder="如：周一至周六 14:30" />
              </el-form-item>
              <el-form-item label="联系电话">
                <el-input v-model="form.contact_phone" placeholder="如：13800000000" />
              </el-form-item>
            </div>
            <div class="grid-2">
              <el-form-item label="面试/工作地址">
                <el-input v-model="form.address" placeholder="如：福田区 XX 路 1 号" />
              </el-form-item>
              <el-form-item label="地址坐标">
                <el-input v-model="form.coordinates" placeholder="纬度,经度" />
              </el-form-item>
            </div>
            <el-form-item label="面试日期（输入后回车新增）">
              <el-select
                v-model="form.interview_days"
                class="full"
                multiple
                filterable
                allow-create
                default-first-option
                :reserve-keyword="false"
                placeholder="如：周一、周二"
              >
                <el-option v-for="day in form.interview_days" :key="day" :label="day" :value="day" />
              </el-select>
            </el-form-item>
            <el-form-item label="面试点（输入后回车新增）">
              <el-select
                v-model="form.interview_points"
                class="full"
                multiple
                filterable
                allow-create
                default-first-option
                :reserve-keyword="false"
                placeholder="如：福田地铁站 A 出口"
              >
                <el-option v-for="point in form.interview_points" :key="point" :label="point" :value="point" />
              </el-select>
            </el-form-item>
            <el-form-item label="岗位图片地址">
              <el-input v-model="form.image_url" placeholder="https://..." />
            </el-form-item>

            <div class="section-title">门店信息（可选）</div>
            <div class="grid-3">
              <el-form-item label="门店名称">
                <el-input v-model="form.store_name" />
              </el-form-item>
              <el-form-item label="门店地址">
                <el-input v-model="form.store_address" />
              </el-form-item>
              <el-form-item label="门店坐标">
                <el-input v-model="form.store_coordinates" placeholder="纬度,经度" />
              </el-form-item>
            </div>
          </el-tab-pane>
        </el-tabs>
      </el-form>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { citiesApi, factoriesApi, positionsApi, apiErrorMessage } from '../../api/core'
import type { City, Factory, ServicePosition } from '../../api/core'
import { toArray } from '../../utils/format'

type Mode = 'create' | 'edit' | 'copy'

const props = defineProps<{
  modelValue: boolean
  mode: Mode
  positionId?: number | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved'): void
}>()

/** 与后端 POSITION_DEFAULTS.base_section_labels 对齐 */
const SECTION_LABELS: Record<string, string> = {
  positions: '招聘工种',
  requirements: '招聘要求',
  salary_detail: '薪资详情',
  salary_ask: '薪资简述',
  work_content: '工作内容',
  meal_dorm: '吃住情况',
  social_insurance: '社保情况',
  shift_info: '班次问题',
  work_hours: '工作时间',
  factory_env: '工厂环境',
  dorm_env: '宿舍环境',
  work_env: '工作环境',
  uniform: '工衣问题',
  medical_fee: '体检费问题',
  luggage_question: '行李问题',
  interview_notice: '面试通知模板',
  checkin_guide: '面试指引',
  registration_form: '报名表单',
}

const SECTION_GROUPS = [
  { key: 'recruit', title: '招聘与要求', keys: ['positions', 'requirements', 'work_content', 'work_hours', 'shift_info'] },
  { key: 'salary', title: '薪资与福利', keys: ['salary_detail', 'salary_ask', 'meal_dorm', 'social_insurance'] },
  { key: 'env', title: '环境与配套', keys: ['factory_env', 'dorm_env', 'work_env', 'uniform', 'medical_fee', 'luggage_question'] },
  { key: 'guide', title: '通知与指引', keys: ['interview_notice', 'checkin_guide', 'registration_form'] },
]

const formRef = ref<FormInstance>()
const loading = ref(false)
const saving = ref(false)
const activeTab = ref('base')
const openGroups = ref<string[]>(['recruit'])
const cities = ref<City[]>([])
const factories = ref<Factory[]>([])
const base = ref<Record<string, unknown>>({})
const original = ref<ServicePosition | null>(null)

const form = reactive({
  position_name: '',
  city_id: null as number | null,
  city_name: '',
  factory_id: null as number | null,
  recruiter_id: '',
  gender: '',
  age_range: '',
  height_require: '',
  job_type: '',
  accommodation: '',
  health_cert: '',
  experience: '',
  district: '',
  is_active: true,
  interview_time: '',
  contact_phone: '',
  address: '',
  coordinates: '',
  image_url: '',
  store_name: '',
  store_address: '',
  store_coordinates: '',
  interview_days: [] as string[],
  interview_points: [] as string[],
  sections: { ...SECTION_LABELS } as Record<string, string>,
})

for (const key of Object.keys(SECTION_LABELS)) form.sections[key] = ''

const sectionGroups = SECTION_GROUPS

const rules: FormRules = {
  position_name: [{ required: true, message: '请输入岗位名称', trigger: 'blur' }],
  city_id: [{ required: true, message: '请选择所属城市', trigger: 'change' }],
}

const title = computed(() => {
  if (props.mode === 'create') return '添加岗位'
  if (props.mode === 'copy') return '复制岗位'
  return '编辑岗位'
})

const cityFactories = computed(() =>
  factories.value.filter((item) => !form.city_id || Number(item.city_id) === form.city_id),
)

function sectionLabel(key: string): string {
  return SECTION_LABELS[key] ?? key
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

async function loadOptions(): Promise<void> {
  if (cities.value.length && factories.value.length) return
  const [cityRes, factoryRes] = await Promise.all([
    citiesApi.list(),
    factoriesApi.list().catch(() => ({ data: { items: [] } })),
  ])
  cities.value = toArray<City>(cityRes.data)
  factories.value = toArray<Factory>((factoryRes as { data: unknown }).data)
}

function fill(source: ServicePosition): void {
  form.position_name = String(source.position_name ?? '')
  form.city_name = String(source.city_name ?? '')
  const matched = cities.value.find((city) => city.city_name === form.city_name)
  form.city_id = matched ? Number(matched.id) : null
  form.factory_id = typeof source.factory_id === 'number' ? source.factory_id : null
  form.recruiter_id = String(source.recruiter_id ?? '')
  form.gender = String(source.gender ?? '')
  form.age_range = String(source.age_range ?? '')
  form.height_require = String(source.height_require ?? '')
  form.job_type = String(source.job_type ?? '')
  form.accommodation = String(source.accommodation ?? '')
  form.health_cert = String(source.health_cert ?? '')
  form.experience = String(source.experience ?? '')
  form.district = String(source.district ?? '')
  form.is_active = source.is_active !== false
  form.interview_time = String(source.interview_time ?? '')
  form.contact_phone = String(source.contact_phone ?? '')
  form.address = String(source.address ?? '')
  form.coordinates = String(source.coordinates ?? '')
  form.image_url = String(source.image_url ?? '')
  form.store_name = String(source.store_name ?? '')
  form.store_address = String(source.store_address ?? '')
  form.store_coordinates = String(source.store_coordinates ?? '')
  form.interview_days = readStrings(source.interview_days)
  form.interview_points = readStrings(source.interview_points)
  const sections = (source.base_sections || {}) as Record<string, unknown>
  const labels = (source.base_section_labels || {}) as Record<string, unknown>
  for (const key of Object.keys(SECTION_LABELS)) {
    form.sections[key] = String(sections[key] ?? '')
    if (typeof labels[key] === 'string') SECTION_LABELS[key] = String(labels[key])
  }
  // 保留后端返回的额外语义段，避免保存后丢失
  for (const [key, value] of Object.entries(sections)) {
    if (!(key in form.sections)) form.sections[key] = String(value ?? '')
  }
}

async function reset(): Promise<void> {
  formRef.value?.clearValidate()
  activeTab.value = 'base'
  base.value = {}
  original.value = null
  form.position_name = ''
  form.city_id = null
  form.city_name = ''
  form.factory_id = null
  form.recruiter_id = ''
  form.gender = ''
  form.age_range = ''
  form.height_require = ''
  form.job_type = ''
  form.accommodation = ''
  form.health_cert = ''
  form.experience = ''
  form.district = ''
  form.is_active = true
  form.interview_time = ''
  form.contact_phone = ''
  form.address = ''
  form.coordinates = ''
  form.image_url = ''
  form.store_name = ''
  form.store_address = ''
  form.store_coordinates = ''
  form.interview_days = []
  form.interview_points = []
  for (const key of Object.keys(form.sections)) form.sections[key] = ''

  loading.value = true
  try {
    await loadOptions()
    if (props.mode === 'create' || !props.positionId) return
    const { data } = await positionsApi.get(props.positionId)
    original.value = data
    base.value = data as unknown as Record<string, unknown>
    fill(data)
    if (props.mode === 'copy') form.position_name = `${form.position_name}（副本）`
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '岗位详情加载失败'))
  } finally {
    loading.value = false
  }
}

function onCityChange(value: number): void {
  const city = cities.value.find((item) => Number(item.id) === Number(value))
  form.city_name = city?.city_name ?? ''
  if (form.factory_id && !cityFactories.value.some((item) => item.id === form.factory_id)) {
    form.factory_id = null
  }
}

function buildPayload(): Record<string, unknown> {
  const source = { ...base.value }
  delete source.id
  delete source.created_at
  delete source.updated_at
  const labelMap = { ...SECTION_LABELS }
  const payload: Record<string, unknown> = {
    ...source,
    position_name: form.position_name.trim(),
    city_id: form.city_id,
    city_name: form.city_name,
    factory_id: form.factory_id,
    recruiter_id: form.recruiter_id,
    gender: form.gender,
    age_range: form.age_range,
    height_require: form.height_require,
    job_type: form.job_type,
    accommodation: form.accommodation,
    health_cert: form.health_cert,
    experience: form.experience,
    district: form.district,
    is_active: form.is_active,
    interview_time: form.interview_time,
    contact_phone: form.contact_phone,
    address: form.address,
    coordinates: form.coordinates,
    image_url: form.image_url,
    store_name: form.store_name,
    store_address: form.store_address,
    store_coordinates: form.store_coordinates,
    interview_days: [...form.interview_days],
    interview_points: [...form.interview_points],
    base_sections: { ...form.sections },
    base_section_labels: labelMap,
  }
  if (form.factory_id) {
    const factory = factories.value.find((item) => item.id === form.factory_id)
    if (factory && !form.store_name) payload.store_name = factory.factory_name
  }
  return payload
}

async function submit(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  saving.value = true
  try {
    const payload = buildPayload() as Partial<ServicePosition>
    if (props.mode === 'edit' && props.positionId) {
      await positionsApi.update(props.positionId, payload)
      ElMessage.success('岗位已保存')
    } else {
      await positionsApi.create(payload)
      ElMessage.success(props.mode === 'copy' ? '岗位副本已创建' : '岗位已创建')
    }
    emit('update:modelValue', false)
    emit('saved')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '保存失败'))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.drawer-body {
  min-height: 320px;
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

.tab-tip {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--bd-text-tertiary);
}

.section-title {
  margin: 12px 0 14px;
  padding-left: 8px;
  border-left: 3px solid var(--bd-primary, #409eff);
  font-size: 14px;
  font-weight: 600;
  color: var(--bd-text-primary);
}
</style>
