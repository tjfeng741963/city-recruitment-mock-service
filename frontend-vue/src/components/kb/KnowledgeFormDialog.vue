<template>
  <el-dialog
    :model-value="modelValue"
    :title="item ? '编辑知识' : '新增知识'"
    width="720px"
    destroy-on-close
    @update:model-value="close"
  >
    <el-form ref="formRef" :model="form" label-width="96px" @submit.prevent>
      <el-form-item label="适用范围">
        <el-select v-model="form.scope" :disabled="!!item">
          <el-option label="所有岗位通用" value="global" />
          <el-option :label="positionName ? `仅用于：${positionName}` : '当前岗位专属（先选岗位）'" value="position" :disabled="!positionId" />
          <el-option v-if="item && !['global','position'].includes(item.scope_level)" :label="`原范围：${item.scope_level}`" :value="item.scope_level" />
        </el-select>
        <span class="kb-sort-hint">工资、地址等事实在招聘岗位维护；通用回答可引用 {wage_text}。</span>
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
          placeholder="填写对外回复内容，涉及工价/厂规时请写明对应工厂或岗位"
        />
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

      <el-row v-if="item && !['global','position'].includes(item.scope_level)" :gutter="12">
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
        <el-col :span="12">
          <el-form-item label="城市">
            <el-select v-model="form.city_id" clearable filterable placeholder="不限城市" class="w-full">
              <el-option v-for="city in cityOptions" :key="city.id" :label="city.name" :value="city.id" />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>

      <el-form-item v-if="item && !['global','position'].includes(item.scope_level)" label="雇主">
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
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="排序">
            <el-input-number v-model="form.sort_order" :min="0" :max="99999" controls-position="right" />
            <span class="kb-sort-hint">数值越大越靠前</span>
          </el-form-item>
        </el-col>
      </el-row>
    </el-form>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="close(false)">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="confirm">
          {{ item ? '保存' : '新增' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { Employer, KnowledgeDraft, KnowledgeItem, LocationNode, Vertical } from '../../api/knowledge'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    positionId?: number
    positionName?: string
    item?: KnowledgeItem | null
    verticals: Vertical[]
    locations: LocationNode[]
    employers: Employer[]
    submitting?: boolean
  }>(),
  { item: null, submitting: false },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'submit', draft: KnowledgeDraft): void
}>()

const formRef = ref()
const keywordInput = ref('')
const originalScope = ref('')
const form = reactive({
  scope: 'global',
  question: '',
  answer: '',
  keywords: [] as string[],
  vertical_id: null as number | null,
  city_id: null as number | null,
  employer_id: null as number | null,
  enabled: true,
  sort_order: 0,
})

const cityOptions = computed(() => props.locations.filter((item) => item.level === 'city'))
const verticalOptions = computed(() => props.verticals.filter((item) => item.status !== 'disabled'))
const employerOptions = computed(() => {
  if (!form.vertical_id) return props.employers
  return props.employers.filter((item) => item.vertical_id === form.vertical_id)
})

function reset(): void {
  const item = props.item
  form.scope = item?.scope_level || (props.positionId ? 'position' : 'global')
  form.question = item?.question ?? ''
  form.answer = item?.answer ?? ''
  form.keywords = [...(item?.keywords ?? [])]
  form.vertical_id = item?.vertical_id ?? null
  form.city_id = item?.scope_level === 'city' ? item.scope_location_id : null
  form.employer_id = item?.scope_level === 'employer' ? item.scope_employer_id : null
  form.enabled = item?.status !== 'disabled'
  form.sort_order = item?.sort_order ?? 0
  originalScope.value = item?.scope_level ?? ''
  keywordInput.value = ''
}

watch(
  () => [props.modelValue, props.item] as const,
  ([visible]) => {
    if (visible) reset()
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
  const scopeLevel = props.item?.scope_level || form.scope
  return {
    question: form.question.trim(),
    answer: form.answer.trim(),
    keywords: [...form.keywords],
    vertical_id: form.vertical_id,
    scope_level: scopeLevel,
    scope_location_id: scopeLevel === 'city' ? form.city_id : null,
    scope_position_id: scopeLevel === 'position' ? (props.item?.scope_position_id ?? props.positionId ?? null) : null,
    scope_employer_id: scopeLevel === 'employer' ? form.employer_id : null,
    status: form.enabled ? 'enabled' : 'disabled',
    sort_order: form.sort_order ?? 0,
  }
}

function confirm(): void {
  addKeyword()
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

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
