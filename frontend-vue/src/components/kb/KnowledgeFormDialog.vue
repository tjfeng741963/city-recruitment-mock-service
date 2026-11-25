<template>
  <el-dialog
    :model-value="modelValue"
    :title="item ? '编辑知识' : copySource ? '复制为新问答' : '新增知识'"
    width="720px"
    destroy-on-close
    @update:model-value="close"
  >
    <el-form ref="formRef" :model="form" label-width="96px" @submit.prevent>
      <el-form-item label="适用范围" :required="!fixedScope">
        <span v-if="fixedScope" class="w-full">{{ existingScopeLabel }}</span>
        <el-select v-else v-model="form.applicability" class="w-full" filterable placeholder="选择通用或搜索岗位">
          <el-option label="所有岗位通用" :value="0" />
          <el-option v-for="position in positions" :key="position.id" :label="positionOptionLabel(position)" :value="position.id" />
        </el-select>
        <span v-if="!fixedScope && positionsLoading" class="kb-sort-hint" role="status">正在加载岗位选项…</span>
        <span v-else-if="!fixedScope && !positionAvailable" class="kb-sort-hint">请选择有效的适用范围。</span>
      </el-form-item>
      <el-form-item label="问题" required>
        <el-input v-model="form.question" maxlength="500" show-word-limit placeholder="例如：厂里管吃住吗？" />
      </el-form-item>

      <el-form-item label="答案" required>
        <el-input
          v-model="form.answer"
          type="textarea"
          :rows="5"
          maxlength="2000"
          show-word-limit
          placeholder="填写对外答复，通用答案可引用 {wage_text}"
        />
      </el-form-item>

      <el-form-item v-if="selectedScope === 'position' || form.media.length" label="随答案发送">
        <div class="faq-media w-full">
          <el-select v-for="kind in mediaKinds" :key="kind.key"
            :model-value="selectedMedia(kind.key)" :aria-label="kind.label" :placeholder="kind.label"
            filterable clearable :loading="mediaLoading" @change="(value: string | undefined) => setMedia(kind.key, value)">
            <el-option v-for="asset in availableMedia(kind.key)" :key="asset.reference"
              :label="asset.name" :value="asset.reference" />
          </el-select>
          <p v-if="mediaError" class="kb-sort-hint" role="status">{{ mediaError }}</p>
          <p v-else-if="missingMedia.length" class="kb-sort-hint" role="status">有素材已失效或不适用当前岗位，请移除或重新选择。</p>
          <div v-for="reference in missingMedia" :key="reference" class="faq-media-missing">
            <span>素材 #{{ reference.split(':')[1] }}</span>
            <el-button link type="danger" @click="removeMedia(reference)">移除</el-button>
          </div>
          <router-link v-if="selectedScope === 'position'" :to="{ path: '/media', query: selectedPositionId ? { position_id: selectedPositionId } : {} }"
            target="_blank" rel="noopener" @click="refreshOnReturn = true">管理图片与视频（新标签页）</router-link>
          <p class="kb-sort-hint">图片（JPG 或 PNG）和视频（MP4）可各选一个。接待测试可预览发送顺序，企微自动发送素材待验证。</p>
        </div>
      </el-form-item>

      <el-form-item label="关键词">
        <div class="kb-tag-input">
          <el-tag
            v-for="tag in form.keywords"
            :key="tag"
            closable
            effect="plain"
            class="kb-tag"
            @close="removeKeyword(tag)"
          >
            {{ tag }}
          </el-tag>
          <el-input
            v-model="keywordInput"
            class="kb-tag-field"
            placeholder="输入后按回车或逗号添加"
            @keydown.enter.prevent="addKeyword"
            @input="onKeywordInput"
            @blur="addKeyword"
          />
        </div>
      </el-form-item>

      <el-row v-if="legacyScope || copySource" :gutter="12">
        <el-col :span="12">
          <el-form-item label="分类">
            <el-select v-model="form.vertical_id" clearable placeholder="全部分类" class="w-full" @change="onVerticalChange">
              <el-option
                v-for="vertical in verticalOptions"
                :key="vertical.id"
                :label="vertical.name"
                :value="vertical.id"
              />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col v-if="legacyScope" :span="12">
          <el-form-item label="城市">
            <el-select v-model="form.city_id" clearable filterable placeholder="不限城市" class="w-full">
              <el-option v-for="city in cityOptions" :key="city.id" :label="city.name" :value="city.id" />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>

      <el-form-item v-if="legacyScope" label="雇主">
        <el-select v-model="form.employer_id" clearable filterable placeholder="不限雇主" class="w-full" @change="onEmployerChange">
          <el-option
            v-for="employer in employerOptions"
            :key="employer.id"
            :label="employer.display_name"
            :value="employer.id"
          />
        </el-select>
      </el-form-item>

      <el-row :gutter="12">
        <el-col :span="12">
          <el-form-item label="是否启用">
            <el-switch v-model="form.enabled" active-text="启用" inactive-text="停用" />
            <span class="kb-sort-hint">通过校验的通用或岗位问答，启用后可用于接待。</span>
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="排序">
            <el-input-number v-model="form.sort_order" :min="0" :max="99999" controls-position="right" />
            <span class="kb-sort-hint">数值越大，排序越靠前</span>
          </el-form-item>
        </el-col>
      </el-row>
    </el-form>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="close(false)">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="confirm">
          {{ item ? '保存' : copySource ? '保存新问答' : '新增' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { Employer, KnowledgeDraft, KnowledgeItem, LocationNode, Vertical } from '../../api/knowledge'
import type { ServicePosition } from '../../api/types'
import { positionOptionLabel } from '../../utils/position-context'
import { mediaApi } from '../../api/core'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    positionId?: number
    positions?: ServicePosition[]
    positionsLoading?: boolean
    item?: KnowledgeItem | null
    copySource?: KnowledgeItem | null
    verticals: Vertical[]
    locations: LocationNode[]
    employers: Employer[]
    submitting?: boolean
  }>(),
  { item: null, positions: () => [], submitting: false },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'submit', draft: KnowledgeDraft): void
}>()

const formRef = ref()
const keywordInput = ref('')
const form = reactive({
  applicability: 0 as number | undefined,
  question: '',
  answer: '',
  keywords: [] as string[],
  media: [] as string[],
  vertical_id: null as number | null,
  city_id: null as number | null,
  employer_id: null as number | null,
  enabled: true,
  sort_order: 0,
})

const cityOptions = computed(() => props.locations.filter((item) => item.level === 'city'))
const verticalOptions = computed(() => props.verticals.filter((item) => item.status !== 'disabled'))
const positionAvailable = computed(() => form.applicability === 0 || props.positions.some(position => position.id === form.applicability))
const legacyScope = computed(() => {
  const source = props.item ?? props.copySource
  return source && !['global', 'position'].includes(source.scope_level) ? source.scope_level : null
})
const fixedScope = computed(() => Boolean(props.item || legacyScope.value))
const selectedPositionId = computed(() => props.item ? props.item.scope_position_id : form.applicability || null)
const selectedScope = computed(() => props.item?.scope_level ?? legacyScope.value ?? (selectedPositionId.value ? 'position' : 'global'))
const mediaKinds = [{ key: 'image', label: '选择图片' }, { key: 'video', label: '选择视频' }] as const
type MediaKind = typeof mediaKinds[number]['key']
const mediaAssets = ref<Array<{ reference: string; name: string; kind: MediaKind; positionId: number }>>([])
const mediaLoading = ref(false)
const mediaError = ref('')
const refreshOnReturn = ref(false)
function availableMedia(kind: MediaKind) {
  return selectedScope.value === 'position'
    ? mediaAssets.value.filter(asset => asset.kind === kind && (!asset.positionId || asset.positionId === selectedPositionId.value))
    : []
}
function selectedMedia(kind: MediaKind): string | undefined {
  return availableMedia(kind).find(asset => form.media.includes(asset.reference))?.reference
}
const missingMedia = computed(() => mediaLoading.value || mediaError.value ? [] : form.media.filter(reference =>
  !mediaKinds.some(kind => selectedMedia(kind.key) === reference)))

function removeMedia(reference: string): void {
  form.media = form.media.filter(item => item !== reference)
}
function setMedia(kind: MediaKind, value: string | undefined): void {
  const previous = selectedMedia(kind)
  if (previous) removeMedia(previous)
  if (value) form.media.push(value)
}
async function loadMedia(): Promise<void> {
  if (mediaLoading.value) return
  mediaLoading.value = true
  mediaError.value = ''
  try {
    const { data } = await mediaApi.list()
    mediaAssets.value = (data.items || []).flatMap(row => row.supports_faq === true && (row.kind === 'image' || row.kind === 'video')
      ? [{ reference: `asset:${row.id}:${row.sha256}`, name: String(row.name), kind: row.kind, positionId: Number(row.position_id) }]
      : [])
  } catch {
    mediaError.value = '素材加载失败，关闭后重新打开可重试。'
  } finally {
    mediaLoading.value = false
  }
}
function refreshMedia(): void {
  if (props.modelValue && refreshOnReturn.value) {
    refreshOnReturn.value = false
    void loadMedia()
  }
}
onMounted(() => window.addEventListener('focus', refreshMedia))
onBeforeUnmount(() => window.removeEventListener('focus', refreshMedia))
const existingScopeLabel = computed(() => {
  const item = props.item ?? props.copySource
  if (!item || item.scope_level === 'global') return '所有岗位通用'
  if (item.scope_level !== 'position') return `原范围：${item.scope_level}`
  const position = props.positions.find(option => option.id === item.scope_position_id)
  return position ? positionOptionLabel(position) : item.scope_position_id ? `岗位 #${item.scope_position_id}` : '原岗位'
})
const employerOptions = computed(() => {
  if (!form.vertical_id) return props.employers
  return props.employers.filter((item) => item.vertical_id === form.vertical_id)
})

function reset(): void {
  const item = props.item ?? props.copySource
  const defaultPosition = props.positionId && (props.positionsLoading || props.positions.some(position => position.id === props.positionId))
    ? props.positionId
    : 0
  form.applicability = props.copySource
    ? props.copySource.scope_level === 'position' ? props.copySource.scope_position_id || undefined : 0
    : defaultPosition
  form.question = item?.question ?? ''
  form.answer = item?.answer ?? ''
  form.keywords = [...(item?.keywords ?? [])]
  form.media = (item?.media ?? []).filter(value => value.startsWith('asset:'))
  form.vertical_id = item?.vertical_id ?? null
  form.city_id = item?.scope_level === 'city' ? item.scope_location_id : null
  form.employer_id = item?.scope_level === 'employer' ? item.scope_employer_id : null
  form.enabled = !props.copySource && item?.status !== 'disabled'
  form.sort_order = item?.sort_order ?? 0
  keywordInput.value = ''
}

watch(
  () => [props.modelValue, props.item, props.copySource] as const,
  ([visible]) => {
    if (visible) {
      reset()
      void loadMedia()
    }
  },
  { immediate: true },
)

function close(value = false): void {
  emit('update:modelValue', value)
}

function addKeyword(): void {
  const value = keywordInput.value.trim().replace(/^[,，]+|[,，]+$/g, '')
  if (!value) {
    keywordInput.value = ''
    return
  }
  const parts = value.split(/[,，]/).map((item) => item.trim()).filter(Boolean)
  for (const part of parts) {
    if (!form.keywords.includes(part)) form.keywords.push(part)
  }
  keywordInput.value = ''
}

function onKeywordInput(value: string): void {
  if (!/[,，]/.test(value)) return
  keywordInput.value = value
  addKeyword()
}

function removeKeyword(tag: string): void {
  form.keywords = form.keywords.filter((item) => item !== tag)
}

function onVerticalChange(): void {
  if (form.employer_id) {
    const employer = props.employers.find((item) => item.id === form.employer_id)
    if (employer && employer.vertical_id !== form.vertical_id) form.employer_id = null
  }
}

function onEmployerChange(): void {
  if (!form.employer_id) return
  const employer = props.employers.find((item) => item.id === form.employer_id)
  if (employer && !form.vertical_id) form.vertical_id = employer.vertical_id
}

function buildDraft(): KnowledgeDraft {
  const selectedPositionId = props.item ? props.item.scope_position_id : form.applicability || null
  const scopeLevel = props.item?.scope_level ?? legacyScope.value ?? (selectedPositionId ? 'position' : 'global')
  return {
    question: form.question.trim(),
    answer: form.answer.trim(),
    keywords: [...form.keywords],
    media: [...(props.item?.media ?? []).filter(value => !value.startsWith('asset:')), ...form.media],
    vertical_id: form.vertical_id,
    scope_level: scopeLevel,
    scope_location_id: scopeLevel === 'city' ? form.city_id : null,
    scope_position_id: scopeLevel === 'position' ? selectedPositionId : null,
    scope_employer_id: scopeLevel === 'employer' ? form.employer_id : null,
    status: form.enabled ? 'enabled' : 'disabled',
    sort_order: form.sort_order ?? 0,
  }
}

function confirm(): void {
  addKeyword()
  if (!fixedScope.value && !positionAvailable.value) {
    ElMessage.warning(props.positionsLoading ? '岗位选项正在加载，请稍候' : '请重新选择适用范围')
    return
  }
  if (form.media.length && (mediaLoading.value || mediaError.value || missingMedia.value.length)) {
    ElMessage.warning('请先核对随答案发送的图片和视频')
    return
  }
  if (!form.question.trim()) {
    ElMessage.warning('请填写问题')
    return
  }
  if (!form.answer.trim()) {
    ElMessage.warning('请填写答案')
    return
  }
  if (form.employer_id && !form.vertical_id) {
    ElMessage.warning('选择雇主后需要同时选择分类')
    return
  }
  emit('submit', buildDraft())
}
</script>

<style scoped>
.kb-tag-input {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 32px;
  padding: 3px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  transition: border-color 0.2s;
}

.kb-tag-input:focus-within {
  border-color: var(--el-color-primary);
}

.kb-tag {
  margin: 0;
}

.kb-tag-field {
  flex: 1;
  min-width: 140px;
}

.kb-tag-field :deep(.el-input__wrapper) {
  box-shadow: none;
  padding: 0;
}

.kb-sort-hint {
  margin-left: 10px;
  font-size: 12px;
  color: var(--bd-text-tertiary);
}

.w-full {
  width: 100%;
}

.faq-media { display: grid; gap: 8px; }
.faq-media .kb-sort-hint { margin: 0; line-height: 1.5; }
.faq-media-missing { display: flex; align-items: center; gap: 8px; }

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
