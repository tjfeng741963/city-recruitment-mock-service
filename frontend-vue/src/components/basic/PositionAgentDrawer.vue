<template>
  <component :is="embedded ? 'section' : ElDrawer"
    v-bind="embedded ? {} : { modelValue, size: '640px', closeOnClickModal: false }"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="load(true)"
  >
    <template v-if="!embedded" #header>
      <div class="drawer-head">
        <b>Agent 配置</b>
        <span class="head-sub">{{ position?.position_name }}</span>
      </div>
    </template>

    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
    <el-tabs v-else v-model="tab">
      <el-tab-pane label="人设" name="persona">
        <el-alert
          class="persona-note"
          type="info"
          show-icon
          :closable="false"
          title="人设设定系统 Agent 的身份、语气和回复要求"
          description="工资、地点和面试时间从岗位资料读取。这里填写怎样和候选人沟通。"
        />
        <div class="field">
          <div class="field-label">
            <span>人设正文</span>
            <span class="char-count">{{ persona.length }} 字</span>
          </div>
          <el-input
            v-model="persona"
            type="textarea"
            :rows="14"
            :disabled="loading"
            placeholder="例如：你是陈姐，在广东做工厂招工十几年……&#10;&#10;写清楚：你是谁、怎么称呼客户、能用什么语气、哪些话绝对不能说。"
          />
        </div>
        <div class="foot">
          <span v-if="personaDirty" class="dirty-hint">未保存</span>
          <el-button v-if="personaDirty" :disabled="savingPersona" @click="persona = savedPersona">取消修改</el-button>
          <el-button type="primary" :disabled="loading || !personaDirty" :loading="savingPersona" @click="savePersona">保存人设</el-button>
        </div>
      </el-tab-pane>

      <el-tab-pane :label="`开场（${openings.length}）`" name="opening">
        <div class="opening-toolbar">
          <el-button size="small" :disabled="openingBusy" class="pill-btn" @click="startAdd('text')">+ 文本</el-button>
          <el-button size="small" :disabled="openingBusy" class="pill-btn" @click="startAdd('image')">+ 图片</el-button>
          <el-button size="small" :disabled="openingBusy" class="pill-btn" @click="startAdd('video')">+ 视频</el-button>
          <span class="opening-hint" v-if="embedded">先填消息正文。旧版开场使用这里保存的内容。使用节点流程的岗位，请在画布选入文字、编排顺序并保存。</span>
          <span class="opening-hint" v-else>旧版开场按此顺序发送。启用的节点流程以画布保存的顺序为准。</span>
        </div>

        <el-dialog
          v-model="editorVisible"
          :title="draft ? `${KIND_LABEL[draft.kind]} · ${draft.id ? '编辑开场' : '新增开场'}` : '开场'"
          width="680px"
          append-to-body
          destroy-on-close
          class="opening-editor-dialog"
          @closed="onEditorClosed"
        >
          <div v-if="draft" class="opening-edit">
            <div class="edit-head">
              <span class="kind-tag">{{ KIND_LABEL[draft.kind] }} · {{ draft.id ? `第 ${draft.seq ?? ''} 条` : '新增一条' }}</span>
              <span class="opening-hint">保存后按列表顺序逐条发送</span>
            </div>
          <el-input
            v-if="draft.kind === 'text'"
            v-model="draft.content"
            type="textarea"
            :rows="5"
            placeholder="可以引用岗位字段，例如：{{factory}} 在招 {{job_title}}，工价 {{wage}}。"
          />
          <template v-else>
            <div class="media-row">
              <el-select v-model="draft.media_name" class="media-select" filterable placeholder="选择素材">
                <el-option
                  v-for="item in mediaOf(draft.kind)"
                  :key="item.name"
                  :label="item.name"
                  :value="item.name"
                />
              </el-select>
              <el-button :loading="uploading" @click="pickMedia()">上传素材</el-button>
              <input ref="fileInput" type="file" class="hidden-input" :accept="acceptOf(draft.kind)" @change="onMediaFile" />
            </div>
            <el-input v-model="draft.content" placeholder="配文（可选）" class="media-caption" />
          </template>
          <el-form-item v-if="!embedded" label="间隔（秒）" class="delay-row">
            <el-input-number v-model="delaySeconds" :min="2" :max="120" controls-position="right" />
          </el-form-item>
          </div>
          <template #footer>
            <el-button @click="editorVisible = false">取消</el-button>
            <el-button type="primary" :loading="savingOpening" @click="saveDraft">保存</el-button>
          </template>
        </el-dialog>

        <div v-if="!loading && openings.length" class="opening-selection">
          <el-checkbox
            :model-value="selectedIds.length === openings.length"
            :indeterminate="selectedIds.length > 0 && selectedIds.length < openings.length"
            :disabled="openingBusy || !openingRevision"
            @change="toggleAllOpenings"
          >全选</el-checkbox>
          <el-button
            size="small"
            type="danger"
            plain
            :disabled="!selectedIds.length || openingBusy || Boolean(draft)"
            :loading="deletingOpenings"
            @click="removeSelected"
          >{{ selectedIds.length ? `删除所选（${selectedIds.length}）` : '删除所选' }}</el-button>
        </div>

        <div v-if="loading" class="opening-empty">加载中…</div>
        <div v-else-if="!openings.length" class="opening-empty">
          还没有开场。点「文本」新增要发送的内容。
        </div>

        <div
          v-for="(entry, index) in openings"
          :key="entry.id"
          class="opening-card"
          :class="{
            'is-editing': draft?.id === entry.id,
            'is-dragging': dragIndex === index,
            'is-drag-over': dragOverIndex === index && dragIndex !== index,
            'is-draggable': canDrag,
          }"
          :draggable="canDrag"
          @dragstart="onDragStart(index, $event)"
          @dragover.prevent="onDragOver(index)"
          @dragleave="onDragLeave(index)"
          @drop.prevent="onDrop(index)"
          @dragend="onDragEnd"
        >
          <div class="opening-head">
            <div class="opening-label">
              <el-checkbox
                :model-value="selectedIds.includes(entry.id)"
                :disabled="openingBusy || !openingRevision"
                :aria-label="`选择第 ${index + 1} 条开场`"
                @change="(checked: unknown) => toggleSelection(entry.id, checked === true)"
              />
              <span class="kind-tag" :class="entry.kind">{{ KIND_LABEL[entry.kind] }} · 第 {{ index + 1 }} 条</span>
            </div>
            <div class="opening-tools">
              <el-button v-if="!embedded" link size="small" :disabled="openingBusy || index === 0" @click="move(index, -1)">上移</el-button>
              <el-button
                v-if="!embedded"
                link
                size="small"
                :disabled="openingBusy || index === openings.length - 1"
                @click="move(index, 1)"
              >
                下移
              </el-button>
              <el-button link size="small" :disabled="openingBusy" @click="startEdit(entry)">编辑</el-button>
              <el-button link size="small" type="danger" :disabled="openingBusy" @click="removeEntry(entry)">删除</el-button>
            </div>
          </div>
          <div class="opening-body">
            <template v-if="entry.kind === 'text'">{{ entry.content }}</template>
            <template v-else>
              素材：<b>{{ entry.media_name || '未设置' }}</b>
              <span v-if="entry.content" class="opening-caption">配文：{{ entry.content }}</span>
            </template>
          </div>
          <div v-if="!embedded" class="opening-delay">间隔 {{ Math.round((entry.delay_ms || 0) / 1000) }} 秒后发下一条</div>
        </div>
      </el-tab-pane>

    </el-tabs>
  </component>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElDrawer, ElMessage, ElMessageBox } from 'element-plus'
import { agentApi } from '../../api/agent'
import { mediaApi } from '../../api/core'
import type { ServicePosition } from '../../api/types'
import { drawerTabForLoad, type AgentDrawerTab } from '../agent/flow-edit-entry'

interface PersonaOpening {
  id: number
  kind: 'text' | 'image' | 'video'
  content: string
  media_name?: string
  delay_ms: number
  seq?: number
}

interface PersonaGetResult {
  persona?: { content?: string; status?: string }
  openings?: PersonaOpening[]
}

interface MediaItem {
  id: number
  name: string
  kind: 'image' | 'video' | string
}

interface OpeningDraft {
  id: number | null
  kind: 'text' | 'image' | 'video'
  content: string
  media_name: string
  delay_ms: number
  seq?: number
}

const KIND_LABEL: Record<string, string> = { text: '文本', image: '图片', video: '视频' }
const MIN_DELAY_MS = 2000
const MAX_BYTES = 20 * 1024 * 1024

const props = withDefaults(defineProps<{ modelValue: boolean; position: ServicePosition | null; initialTab?: AgentDrawerTab; embedded?: boolean }>(), { initialTab: 'persona' })
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void; (e: 'changed'): void }>()

const tab = ref<AgentDrawerTab>('persona')
const loading = ref(false)
const loadError = ref('')
const persona = ref('')
const savedPersona = ref('')
const openings = ref<PersonaOpening[]>([])
const selectedIds = ref<number[]>([])
const openingRevision = ref('')
const deletingOpenings = ref(false)
const updatingOpenings = ref(false)
const mediaItems = ref<MediaItem[]>([])
const savingPersona = ref(false)
const savingOpening = ref(false)
const uploading = ref(false)
const draft = ref<OpeningDraft | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
// 编辑改为模态框：内联展开在长列表里会把下面的条目顶走，改一条要来回滚
const editorVisible = ref(false)
// 拖拽排序：只记录下标，落点高亮靠 CSS，真正重排走 reorderOpenings
const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

const openingBusy = computed(() => loading.value || savingOpening.value || deletingOpenings.value || updatingOpenings.value)
// 只有一条时拖拽没有意义；embedded（内嵌在岗位抽屉）里仍允许拖，顺序对发送有影响
const canDrag = computed(() => !openingBusy.value && openings.value.length > 1)

const personaDirty = computed(() => persona.value !== savedPersona.value)
const delaySeconds = computed({
  get: () => Math.round((draft.value?.delay_ms || MIN_DELAY_MS) / 1000),
  set: (value: number) => {
    if (draft.value) draft.value.delay_ms = Math.max(MIN_DELAY_MS, Math.round(value * 1000))
  },
})

function mediaOf(kind: string): MediaItem[] {
  return mediaItems.value.filter((item) => item.kind === kind)
}

function acceptOf(kind: string): string {
  return kind === 'image' ? 'image/*' : 'video/*'
}

async function load(opening = false): Promise<void> {
  if (!props.position) return
  loading.value = true
  loadError.value = ''
  draft.value = null
  tab.value = drawerTabForLoad(tab.value, props.initialTab, opening)
  selectedIds.value = []
  openingRevision.value = ''
  try {
    const { data } = await agentApi.personaGet(props.position.id)
    persona.value = String(data.persona?.content || '')
    savedPersona.value = persona.value
    openings.value = (Array.isArray(data.openings) ? data.openings : []) as unknown as PersonaOpening[]
    openingRevision.value = data.opening_revision || ''
  } catch (error: any) {
    loadError.value = error?.response?.data?.detail || 'Agent 配置加载失败，请重新打开岗位设置。'
  } finally {
    loading.value = false
  }
}

async function loadMedia(): Promise<void> {
  try {
    const { data } = await mediaApi.list()
    mediaItems.value = ((data.items || []) as unknown) as MediaItem[]
  } catch {
    mediaItems.value = []
  }
}

async function savePersona(): Promise<void> {
  if (!props.position) return
  savingPersona.value = true
  try {
    await agentApi.personaSave({ position_id: props.position.id, content: persona.value })
    savedPersona.value = persona.value
    ElMessage.success('人设已保存')
    emit('changed')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '人设保存失败')
  } finally {
    savingPersona.value = false
  }
}

function startAdd(kind: 'text' | 'image' | 'video'): void {
  void loadMedia()
  draft.value = { id: null, kind, content: '', media_name: '', delay_ms: MIN_DELAY_MS }
  editorVisible.value = true
}

function startEdit(entry: PersonaOpening): void {
  void loadMedia()
  draft.value = {
    id: entry.id,
    kind: entry.kind,
    content: entry.content || '',
    media_name: entry.media_name || '',
    delay_ms: entry.delay_ms ?? MIN_DELAY_MS,
    seq: entry.seq,
  }
  editorVisible.value = true
}

function onEditorClosed(): void {
  draft.value = null
}

function onDragStart(index: number, event: DragEvent): void {
  if (!canDrag.value) return
  dragIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }
}

function onDragOver(index: number): void {
  if (dragIndex.value === null || dragIndex.value === index) return
  dragOverIndex.value = index
}

function onDragLeave(index: number): void {
  if (dragOverIndex.value === index) dragOverIndex.value = null
}

function onDragEnd(): void {
  dragIndex.value = null
  dragOverIndex.value = null
}

/** 拖到目标位置：先本地重排让界面跟手，再让后端在一个事务里重写 seq。 */
async function onDrop(index: number): Promise<void> {
  const from = dragIndex.value
  dragIndex.value = null
  dragOverIndex.value = null
  if (from === null || from === index || !props.position || openingBusy.value) return
  const positionId = props.position.id
  const ids = openings.value.map((entry) => entry.id)
  const moved = [...ids]
  const [picked] = moved.splice(from, 1)
  moved.splice(index, 0, picked)
  const reordered = [...openings.value]
  const [item] = reordered.splice(from, 1)
  reordered.splice(index, 0, item)
  openings.value = reordered
  try {
    updatingOpenings.value = true
    await agentApi.reorderOpenings({ position_id: positionId, ids: moved })
    if (props.position?.id !== positionId) return
    await load()
    emit('changed')
    ElMessage.success('顺序已更新')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '排序失败')
    await load()
  } finally {
    updatingOpenings.value = false
  }
}

function pickMedia(): void {
  fileInput.value?.click()
}

async function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

async function onMediaFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !draft.value) return
  if (file.size > MAX_BYTES) {
    ElMessage.error('文件超过 20MB，请先压缩')
    return
  }
  const kind = file.type.startsWith('video') ? 'video' : 'image'
  uploading.value = true
  try {
    const data_base64 = await readAsBase64(file)
    const { data } = await mediaApi.add({ name: file.name, kind, position_id: 0, data_base64 })
    await loadMedia()
    if (draft.value) draft.value.media_name = String(data?.name || file.name)
    ElMessage.success('素材已上传')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '上传失败')
  } finally {
    uploading.value = false
  }
}

async function saveDraft(): Promise<void> {
  const entry = draft.value
  if (!entry || !props.position) return
  if (entry.content.length > 2000) {
    ElMessage.warning('消息正文最多 2000 字。')
    return
  }
  if (entry.kind === 'text' && !entry.content.trim()) {
    ElMessage.warning('正文不能为空')
    return
  }
  if (entry.kind !== 'text' && !entry.media_name) {
    ElMessage.warning('请选择素材')
    return
  }
  savingOpening.value = true
  try {
    const payload = {
      position_id: props.position.id,
      kind: entry.kind,
      content: entry.content,
      media_name: entry.media_name,
      delay_ms: entry.delay_ms,
    }
    if (entry.id) await agentApi.updateOpening(entry.id, payload)
    else await agentApi.createOpening(payload)
    ElMessage.success(entry.id ? '已保存' : '已添加')
    editorVisible.value = false
    draft.value = null
    await load()
    emit('changed')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '保存失败')
  } finally {
    savingOpening.value = false
  }
}

function toggleAllOpenings(checked: unknown): void {
  selectedIds.value = checked === true ? openings.value.map(entry => entry.id) : []
}

function toggleSelection(id: number, checked: boolean): void {
  selectedIds.value = checked
    ? [...selectedIds.value, id]
    : selectedIds.value.filter(selected => selected !== id)
}

async function removeSelected(): Promise<void> {
  const positionId = props.position?.id
  const ids = [...selectedIds.value]
  const revision = openingRevision.value
  if (!positionId || !ids.length || !revision || openingBusy.value || draft.value) return
  deletingOpenings.value = true
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${ids.length} 条旧版开场？已保存的画布节点继续按当前配置执行。`,
      '批量删除开场',
      { type: 'warning', confirmButtonText: `删除 ${ids.length} 条`, cancelButtonText: '取消' },
    )
    if ((!props.embedded && !props.modelValue) || props.position?.id !== positionId) return
    const { data } = await agentApi.removeOpenings({ position_id: positionId, ids, revision })
    if (props.position?.id !== positionId) return
    openings.value = data.items as unknown as PersonaOpening[]
    openingRevision.value = data.opening_revision
    selectedIds.value = []
    ElMessage.success(`已删除 ${data.deleted_count} 条开场`)
    emit('changed')
  } catch (error: any) {
    if (error === 'cancel' || error === 'close' || props.position?.id !== positionId) return
    if (error?.response?.status === 409) {
      ElMessage.warning('开场列表已更新，请重新勾选')
      try {
        const { data } = await agentApi.personaGet(positionId)
        if (props.position?.id === positionId) {
          openings.value = (data.openings || []) as unknown as PersonaOpening[]
          openingRevision.value = data.opening_revision || ''
          selectedIds.value = []
        }
      } catch {
        ElMessage.error('开场刷新失败，请重新打开配置')
      }
    } else {
      ElMessage.error(error?.response?.data?.detail || '批量删除失败')
    }
  } finally {
    deletingOpenings.value = false
  }
}

async function removeEntry(entry: PersonaOpening): Promise<void> {
  if (openingBusy.value) return
  updatingOpenings.value = true
  try {
    await ElMessageBox.confirm('删除后，旧版开场将跳过此条。已保存的画布节点仍使用编排时选入的文字。', '删除开场', { type: 'warning' })
    await agentApi.removeOpening(entry.id)
    ElMessage.success('已删除')
    await load()
    emit('changed')
  } catch (error: any) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.response?.data?.detail || '删除失败')
  } finally {
    updatingOpenings.value = false
  }
}

async function move(index: number, offset: number): Promise<void> {
  const target = index + offset
  if (openingBusy.value || target < 0 || target >= openings.value.length || !props.position) return
  const ids = openings.value.map((entry) => entry.id)
  const swapped = [...ids]
  ;[swapped[index], swapped[target]] = [swapped[target], swapped[index]]
  try {
    updatingOpenings.value = true
    await agentApi.reorderOpenings({ position_id: props.position.id, ids: swapped })
    await load()
    emit('changed')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '排序失败')
  } finally {
    updatingOpenings.value = false
  }
}
onMounted(() => {
  if (props.embedded) void load(true)
})

defineExpose({ hasPendingChanges: () => personaDirty.value || draft.value !== null || savingPersona.value || openingBusy.value })
</script>

<style scoped>
.drawer-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.drawer-head b {
  font-size: 15px;
}

.head-sub {
  font-size: 12px;
  color: var(--bd-text-tertiary, #8a94a6);
}

.persona-note {
  margin-bottom: 12px;
}

.field-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 12.5px;
  color: var(--bd-text-secondary, #5f6b7a);
}

.char-count {
  color: var(--bd-text-tertiary, #8a94a6);
}

.foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 10px;
}

.dirty-hint {
  font-size: 12px;
  color: #b26a00;
}

.opening-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.pill-btn {
  background: #ffffff !important;
  border: 1px solid #c4c7c5 !important;
  color: #0b57d0 !important;
  font-weight: 600;
}

.pill-btn:hover:not(.is-disabled) {
  background: #f0f4f9 !important;
  border-color: #0b57d0 !important;
  color: #0842a0 !important;
}


.edit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}


.opening-card.is-editing {
  border-color: var(--bd-primary, #0b57d0);
  box-shadow: 0 0 0 2px rgba(11, 87, 208, 0.12);
}

.opening-hint {
  font-size: 11.5px;
  color: var(--bd-text-tertiary, #8a94a6);
}

.opening-empty {
  padding: 24px 8px;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--bd-text-tertiary, #8a94a6);
}

.opening-card {
  border: 1px solid var(--bd-border, #e8ecf3);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
}

/* 拖动排序：抓住卡片任意位置拖动，落点用虚线边框 + 顶部高亮线提示 */
.opening-card.is-draggable {
  cursor: grab;
}

.opening-card.is-draggable:active {
  cursor: grabbing;
}

.opening-card.is-dragging {
  opacity: 0.4;
}

.opening-card.is-drag-over {
  border-color: var(--bd-primary, #0b57d0);
  border-style: dashed;
  box-shadow: 0 -2px 0 0 var(--bd-primary, #0b57d0);
}

.opening-editor-dialog .opening-edit {
  padding: 0;
}

.opening-selection,
.opening-label {
  display: flex;
  align-items: center;
  gap: 8px;
}

.opening-selection {
  justify-content: space-between;
  margin-bottom: 8px;
}

.opening-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.kind-tag {
  font-size: 12px;
  font-weight: 600;
  color: var(--bd-primary, #0b57d0);
}

.kind-tag.image,
.kind-tag.video {
  color: #b26a00;
}

.opening-tools {
  display: flex;
  align-items: center;
  gap: 2px;
}

.opening-body {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--bd-text-primary);
}

.opening-caption {
  display: block;
  margin-top: 4px;
  color: var(--bd-text-secondary, #5f6b7a);
}

.opening-delay {
  margin-top: 6px;
  font-size: 11px;
  color: var(--bd-text-tertiary, #8a94a6);
}

.opening-edit {
  border: 1px solid var(--bd-primary, #0b57d0);
  border-radius: 10px;
  padding: 12px;
  margin-top: 12px;
}

.media-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.media-select {
  flex: 1;
}

.media-caption {
  margin-top: 8px;
}

.delay-row {
  margin-top: 10px;
}

.edit-tools {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}







.hidden-input {
  display: none;
}
</style>
