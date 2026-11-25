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
                <span v-if="mode === 'create' && form.city_id" class="tab-tip">保存时，空白项沿用城市默认资料。</span>
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
            <div class="line-legend">
              <el-tag effect="plain" type="primary">系统 Agent</el-tag>
              <span>读取本岗位资料。</span>
              <el-tag effect="plain" type="warning">Dify 工作流</el-tag>
              <span>岗位优先，空白沿用城市资料。</span>
            </div>
            <div v-if="cityOverrides.length" class="line-legend">
              <el-tag effect="plain" type="warning">Dify 城市默认值</el-tag>
              <span v-for="value in cityOverrides" :key="value">{{ value }}</span>
            </div>
            <el-collapse v-model="openGroups">
              <el-collapse-item
                v-for="group in sectionGroups"
                :key="group.key"
                :title="group.title"
                :name="group.key"
              >
                <el-form-item v-for="key in group.keys" :key="key">
                  <template #label>
                    <span class="field-label-with-line">
                      <span data-position-field-name>{{ sectionLabel(key) }}</span>
                      <el-tag size="small" effect="plain" type="primary">系统 Agent</el-tag>
                      <el-tag size="small" effect="plain" type="warning">Dify · 岗位优先</el-tag>
                    </span>
                  </template>
                  <el-input
                    v-model="form.sections[key]"
                    type="textarea"
                    :rows="key === 'interview_notice' || key === 'checkin_guide' ? 4 : 2"
                    :placeholder="`填写${sectionLabel(key)}的岗位资料`"
                  />
                </el-form-item>
              </el-collapse-item>
            </el-collapse>
          </el-tab-pane>

          <el-tab-pane label="面试与门店" name="interview">
            <div class="line-legend">
              <el-tag effect="plain" type="primary">系统 Agent</el-tag><span>根据已填地址和面试点回答。</span>
              <el-tag effect="plain" type="warning">Dify 工作流</el-tag><span>预约优先使用所选面试点的地址和专属时间。默认日程优先读取已保存的岗位，空白项沿用城市资料。</span>
            </div>
            <div class="grid-2">
              <el-form-item label="面试时间">
                <el-input v-model="form.interview_time" placeholder="如：周一至周六 14:30" />
              </el-form-item>
              <el-form-item label="联系电话">
                <el-input v-model="form.contact_phone" placeholder="如：13800000000" />
              </el-form-item>
            </div>
            <div class="grid-2">
              <el-form-item label="工作地址">
                <el-input v-model="form.work_address" placeholder="填写实际工作地点" />
              </el-form-item>
              <el-form-item label="默认面试地址">
                <el-input v-model="form.interview_address" placeholder="填写默认集合或面试地点" />
              </el-form-item>
              <el-form-item label="岗位地址坐标">
                <el-input v-model="form.coordinates" placeholder="纬度,经度" />
              </el-form-item>
            </div>
            <el-form-item>
              <template #label>
                <span class="field-label-with-line">可面试星期 <el-tag size="small" effect="plain" type="warning">Dify · 预约规则</el-tag></span>
              </template>
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
            <section class="interview-points" aria-label="面试点">
              <div class="section-title point-heading">
                <span>面试点</span>
                <el-button type="primary" plain @click="form.interview_points.push({ name: '', address: '', lng: '', lat: '', interview_time: '', checkin_guide: '', favorite_title: '', favorite_delay_seconds: 0 })">新增面试点</el-button>
              </div>
              <div v-for="(point, index) in form.interview_points" :key="index" class="point-card">
                <div class="point-heading">
                  <strong>{{ point.name.trim() || '新面试点' }}</strong>
                  <el-button link type="danger" :aria-label="'移除面试点 ' + (index + 1)" @click="form.interview_points.splice(index, 1)">移除</el-button>
                </div>
                <div class="point-fields">
                  <el-form-item label="面试点名称" :prop="'interview_points.' + index + '.name'"
                    :rules="[{ required: true, whitespace: true, message: '请输入面试点名称', trigger: 'blur' }]">
                    <el-input v-model="point.name" placeholder="如：地铁 1 号线面试点" />
                  </el-form-item>
                  <el-form-item label="详细地址">
                    <el-input v-model="point.address" placeholder="预约需填详细地址，如兴业路 8 号东门" />
                  </el-form-item>
                  <el-form-item label="位置卡经度">
                    <el-input v-model="point.lng" placeholder="如 113.39114" />
                  </el-form-item>
                  <el-form-item label="位置卡纬度">
                    <el-input v-model="point.lat" placeholder="如 23.117692" />
                  </el-form-item>
                </div>
                <el-form-item label="企微收藏名称（可选）">
                  <el-input v-model="point.favorite_title" maxlength="100" placeholder="填写位置卡在企业微信收藏里显示的完整名称" />
                  <span class="tab-tip point-time-tip">保留旧收藏名称；画布位置卡使用上面的地址和坐标，无需收藏。</span>
                </el-form-item>
                <el-form-item v-if="point.favorite_title.trim()" label="Dify · 地址文字后等待（秒）">
                  <el-input-number v-model="point.favorite_delay_seconds" :min="0" :max="60" :step="0.5" :precision="1" controls-position="right" />
                  <span class="tab-tip point-time-tip">适用于求职者明确索要面试定位且选点成功的回复。Agent 的发送位置和等待在画布节点里设置。</span>
                </el-form-item>
                <el-form-item label="本点面试时间（可选）">
                  <el-input v-model="point.interview_time" placeholder="如 11:00 或 14:00–16:00，留空用默认日程" />
                </el-form-item>
                <el-form-item label="本点到场指引（可选）">
                  <el-input v-model="point.checkin_guide" type="textarea" :rows="2"
                    placeholder="填写该点的入口、楼层或房间" />
                </el-form-item>
              </div>
            </section>
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
          <el-tab-pane v-if="auth.user?.role === 'admin'" label="系统 Agent" name="agent">
            <div class="agent-intro">
              <el-tag effect="plain" type="primary">系统 Agent</el-tag>
              <span>先保存人设与消息正文，再到画布编排发送顺序和等待条件。</span>
              <el-button v-if="editableAgentPosition" size="small" plain @click="openAgentCanvas">去画布编排</el-button>
            </div>
            <p v-if="!editableAgentPosition" class="tab-tip">先保存岗位，重新打开后可编辑本岗位的 Agent 话术。</p>
            <PositionAgentDrawer v-else-if="modelValue && agentEditorOpened" ref="agentEditor" :key="editableAgentPosition.id"
              :position="editableAgentPosition" :model-value="true" embedded />
          </el-tab-pane>
        </el-tabs>
      </el-form>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button v-if="activeTab !== 'agent'" type="primary"
        :disabled="loading || (mode !== 'create' && !original)" :loading="saving" @click="submit">保存岗位资料</el-button>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../../stores/auth'
import PositionAgentDrawer from './PositionAgentDrawer.vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { citiesApi, factoriesApi, positionsApi, apiErrorMessage } from '../../api/core'
import type { City, Factory, ServicePosition } from '../../api/core'
import { toArray } from '../../utils/format'

type Mode = 'create' | 'edit' | 'copy'

const props = defineProps<{
  modelValue: boolean
  mode: Mode
  positionId?: number | null
  initialCityId?: number
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
const auth = useAuthStore()
const router = useRouter()
const agentEditor = ref<InstanceType<typeof PositionAgentDrawer> | null>(null)
const agentEditorOpened = ref(false)
watch(activeTab, tab => { if (tab === 'agent') agentEditorOpened.value = true })
const formBaseline = ref('')
const cities = ref<City[]>([])
const factories = ref<Factory[]>([])
const base = ref<Record<string, unknown>>({})
const original = ref<ServicePosition | null>(null)
const editableAgentPosition = computed(() => props.mode === 'edit' ? original.value : null)

async function openAgentCanvas(): Promise<void> {
  if (!editableAgentPosition.value) return
  if (agentEditor.value?.hasPendingChanges()) {
    ElMessage.warning('请先保存或取消当前 Agent 文字编辑。')
    return
  }
  if (formBaseline.value !== JSON.stringify(form)) {
    try {
      await ElMessageBox.confirm('岗位资料有未保存的修改。离开前可以返回并保存岗位资料。', '打开话术画布', {
        confirmButtonText: '放弃修改并打开画布', cancelButtonText: '返回岗位', type: 'warning',
      })
    } catch { return }
  }
  const id = editableAgentPosition.value.id
  await router.push({ path: '/recruitment-flow', query: { position_id: String(id), edit: '1' } })
}

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
  work_address: '',
  interview_address: '',
  coordinates: '',
  image_url: '',
  store_name: '',
  store_address: '',
  store_coordinates: '',
  interview_days: [] as string[],
  interview_points: [] as Array<{
    name: string; address: string; lng: string; lat: string; interview_time: string; checkin_guide: string; favorite_title: string; favorite_delay_seconds: number; original?: unknown
  }>,
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
const cityOverrides = computed(() => {
  const city = cities.value.find(item => Number(item.id) === form.city_id)
  if (!city) return []
  const sections = (city.prompt_sections ?? {}) as Record<string, unknown>
  const values = [
    ['工资', (city.salary as {raw?: string} | undefined)?.raw, sections.salary_detail, sections.salary_ask],
    ['班次', (city.work_hours as {raw?: string} | undefined)?.raw, sections.work_hours, sections.shift_info],
  ]
  return values.flatMap(([label, ...options]) => {
    const value = options.find(option => typeof option === 'string' && option.trim())
    return typeof value === 'string' ? [`${label} ${value.trim()}`] : []
  })
})

function sectionLabel(key: string): string {
  return SECTION_LABELS[key] ?? key
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

async function loadOptions(): Promise<void> {
  if (cities.value.length && factories.value.length) return
  const [cityRes, factoryRes] = await Promise.all([
    citiesApi.list({page: 1, page_size: 1000}),
    factoriesApi.list({page: 1, page_size: 1000}).catch(() => ({ data: { items: [] } })),
  ])
  cities.value = toArray<City>(cityRes.data)
  factories.value = toArray<Factory>((factoryRes as { data: unknown }).data)
}

function fill(source: ServicePosition): void {
  form.position_name = String(source.position_name ?? '')
  form.city_name = String(source.city_name ?? '')
  const cityId = source.city_id
  const matched = cities.value.find(city => cityId ? Number(city.id) === cityId : city.city_name === form.city_name)
  form.city_id = cityId || (matched ? Number(matched.id) : null)
  if (!form.city_name && matched) form.city_name = matched.city_name
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
  const legacyAddress = String(source.address || source.store_address || '')
  form.work_address = typeof source.work_address === 'string' ? source.work_address : legacyAddress
  form.interview_address = typeof source.interview_address === 'string' ? source.interview_address : legacyAddress
  form.coordinates = String(source.coordinates ?? '')
  form.image_url = String(source.image_url ?? '')
  form.store_name = String(source.store_name ?? '')
  form.store_address = String(source.store_address ?? '')
  form.store_coordinates = String(source.store_coordinates ?? '')
  form.interview_days = readStrings(source.interview_days)
  form.interview_points = Array.isArray(source.interview_points) ? source.interview_points.flatMap(point => {
    if (typeof point === 'string' && point.trim()) {
      return [{ name: point, address: '', lng: '', lat: '', interview_time: '', checkin_guide: '', favorite_title: '', favorite_delay_seconds: 0, original: point }]
    }
    if (point && typeof point.name === 'string' && point.name.trim()) {
      return [{
        name: point.name,
        address: typeof point.address === 'string' ? point.address : '',
        lng: point.lng === undefined || point.lng === null ? '' : String(point.lng),
        lat: point.lat === undefined || point.lat === null ? '' : String(point.lat),
        interview_time: typeof point.interview_time === 'string' ? point.interview_time : '',
        checkin_guide: typeof point.checkin_guide === 'string' ? point.checkin_guide : '',
        favorite_title: typeof point.favorite_title === 'string' ? point.favorite_title : '',
        favorite_delay_seconds: typeof point.favorite_delay_ms === 'number' ? point.favorite_delay_ms / 1000 : 0,
        original: point,
      }]
    }
    return []
  }) : []
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
  agentEditorOpened.value = false
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
  form.work_address = ''
  form.interview_address = ''
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
    if (props.mode === 'create') {
      const city = cities.value.find(item => item.id === props.initialCityId)
      if (city) {
        form.city_id = city.id
        onCityChange(city.id)
      }
      return
    }
    if (!props.positionId) return
    const { data } = await positionsApi.get(props.positionId)
    original.value = data
    base.value = data as unknown as Record<string, unknown>
    fill(data)
    if (props.mode === 'copy') form.position_name = `${form.position_name}（副本）`
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '岗位详情加载失败'))
  } finally {
    formBaseline.value = JSON.stringify(form)
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
    address: form.interview_address.trim() || form.work_address.trim(),
    work_address: form.work_address.trim(),
    interview_address: form.interview_address.trim(),
    coordinates: form.coordinates,
    image_url: form.image_url,
    store_name: form.store_name,
    store_address: form.store_address,
    store_coordinates: form.store_coordinates,
    interview_days: [...form.interview_days],
    interview_points: form.interview_points.map(point => {
      const name = point.name.trim()
      const address = point.address.trim()
      const interview_time = point.interview_time.trim()
      const checkin_guide = point.checkin_guide.trim()
      const favorite_title = point.favorite_title.trim()
      if (typeof point.original === 'string' && point.original === name && !address && !point.lng.trim() && !point.lat.trim() && !interview_time && !checkin_guide && !favorite_title) return point.original
      const previous = point.original && typeof point.original === 'object' ? point.original : {}
      const favorite_delay_ms = favorite_title ? Math.round((point.favorite_delay_seconds || 0) * 1000) : 0
      return { ...previous, name, address, lng: point.lng.trim() ? Number(point.lng) : null,
        lat: point.lat.trim() ? Number(point.lat) : null, interview_time, checkin_guide, favorite_title, favorite_delay_ms }
    }),
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
  if (!formRef.value || saving.value) return
  if (props.mode !== 'create' && !original.value) return
  const names = form.interview_points.map(point => point.name.trim().toLowerCase())
  if (names.some(name => !name) || new Set(names).size !== names.length) {
    activeTab.value = 'interview'
    ElMessage.warning('请为每个面试点填写不同的名称。')
    return
  }
  if (form.interview_points.some(point => {
    const lng = point.lng.trim(), lat = point.lat.trim()
    return (lng || lat) && (!lng || !lat || !Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))
      || !Number(lng) || !Number(lat) || Math.abs(Number(lng)) > 180 || Math.abs(Number(lat)) > 90)
  })) {
    activeTab.value = 'interview'
    ElMessage.warning('请填写完整有效的经纬度；经度范围 ±180，纬度范围 ±90。')
    return
  }
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid || saving.value) return
  saving.value = true
  try {
    const payload = buildPayload() as Partial<ServicePosition>
    if (props.mode === 'edit' && props.positionId) {
      const current = original.value
      const submittedForm = JSON.stringify(form)
      const { data } = await positionsApi.update(props.positionId, payload)
      if (original.value === current) {
        original.value = data
        base.value = { ...data }
        formBaseline.value = submittedForm
      }
      ElMessage.success('岗位已保存')
    } else {
      await positionsApi.create(payload)
      ElMessage.success(props.mode === 'copy' ? '岗位副本已创建' : '岗位已创建')
      emit('update:modelValue', false)
    }
    emit('saved')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '保存失败'))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.line-legend, .agent-intro, .field-label-with-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.line-legend, .agent-intro { margin: 4px 0 16px; color: var(--el-text-color-regular); font-size: 13px; }
.point-heading { display: flex; justify-content: space-between; align-items: center; }
.point-card { border: 1px solid var(--el-border-color); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; }
.point-card .point-heading { margin-bottom: 10px; }
.point-card :deep(.el-form-item:last-child) { margin-bottom: 0; }
.point-fields { display: grid; grid-template-columns: 1fr 1.5fr; gap: 0 16px; }
@media (max-width: 640px) { .point-fields { grid-template-columns: 1fr; } }

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
