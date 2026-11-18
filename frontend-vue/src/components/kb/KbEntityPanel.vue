<template>
  <section class="kb-entity">
    <div class="entity-toolbar">
      <el-input
        v-model="keyword"
        class="entity-search"
        :placeholder="config.searchPlaceholder"
        clearable
        :prefix-icon="Search"
      />
      <el-button type="primary" :icon="Plus" @click="openCreate">新建{{ config.label }}</el-button>
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="paged" row-key="id">
        <template #empty>
          <el-empty :description="`暂无${config.label}数据`" />
        </template>
        <el-table-column
          v-for="column in config.columns"
          :key="column.prop"
          :label="column.label"
          :min-width="column.minWidth"
        >
          <template #default="{ row }">
            <template v-if="column.prop === 'status'">
              <el-tag :type="row.status === 'enabled' ? 'success' : 'info'" size="small">
                {{ row.status === 'enabled' ? '启用' : '停用' }}
              </el-tag>
            </template>
            <template v-else-if="column.lookup">
              {{ lookupName(column.lookup, row[column.prop]) || '—' }}
            </template>
            <template v-else-if="column.prop === 'aliases'">
              {{ Array.isArray(row.aliases) && row.aliases.length ? row.aliases.join(' / ') : '—' }}
            </template>
            <template v-else-if="column.prop === 'walk_guide'">
              <span class="wrap-cell">{{ row.walk_guide || '—' }}</span>
            </template>
            <template v-else>
              {{ row[column.prop] || '—' }}
            </template>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link :type="row.status === 'enabled' ? 'warning' : 'success'" @click="toggleStatus(row)">
              {{ row.status === 'enabled' ? '停用' : '启用' }}
            </el-button>
            <el-button link type="danger" @click="removeRow(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="filtered.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </div>

    <el-dialog
      v-model="editorVisible"
      :title="`${editingId ? '编辑' : '新建'}${config.label}`"
      width="560px"
      :close-on-click-modal="false"
    >
      <el-form label-position="top">
        <el-form-item
          v-for="field in config.fields"
          :key="field.name"
          :label="`${field.label}${field.required ? ' *' : ''}`"
        >
          <el-select
            v-if="field.type === 'select'"
            :model-value="draft[field.name] ?? ''"
            class="full"
            :clearable="Boolean(field.allowEmpty)"
            filterable
            @update:model-value="(value: number | '') => setDraft(field.name, value)"
          >
            <el-option v-if="field.allowEmpty !== undefined" :label="field.allowEmpty" value="" />
            <el-option
              v-for="option in selectOptions(field)"
              :key="String(option.value)"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <el-input
            v-else-if="field.type === 'list'"
            :model-value="Array.isArray(draft[field.name]) ? (draft[field.name] as string[]).join(', ') : ''"
            :placeholder="field.placeholder"
            @update:model-value="(value: string) => setDraft(field.name, value.split(/[,，]/).map((s) => s.trim()).filter(Boolean))"
          />
          <el-input-number
            v-else-if="field.type === 'number'"
            :model-value="Number(draft[field.name] ?? 0)"
            class="full"
            @update:model-value="(value: number) => setDraft(field.name, value)"
          />
          <el-input
            v-else-if="field.type === 'textarea'"
            v-model="draft[field.name] as string"
            type="textarea"
            :rows="3"
            :placeholder="field.placeholder"
          />
          <el-input
            v-else
            v-model="draft[field.name] as string"
            :placeholder="field.placeholder"
            :disabled="field.readonly && Boolean(editingId)"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editorVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import { kbResourceApi, listEmployers, listLocations, listVerticals } from '../../api/knowledge'
import type { KbResource } from '../../api/knowledge'

type Row = Record<string, unknown> & { id: number; status: string }

interface Column {
  prop: string
  label: string
  minWidth?: number
  lookup?: 'locations' | 'verticals'
}

interface Field {
  name: string
  label: string
  required?: boolean
  readonly?: boolean
  placeholder?: string
  type?: 'text' | 'number' | 'select' | 'textarea' | 'list'
  source?: 'locations' | 'verticals'
  allowEmpty?: string
}

interface EntityConfig {
  label: string
  resource: KbResource
  searchPlaceholder: string
  columns: Column[]
  fields: Field[]
}

const CONFIGS: Record<string, EntityConfig> = {
  vertical: {
    label: '品类',
    resource: 'verticals',
    searchPlaceholder: '搜索编码或名称...',
    columns: [
      { prop: 'code', label: '编码', minWidth: 120 },
      { prop: 'name', label: '名称', minWidth: 140 },
      { prop: 'sort_order', label: '排序', minWidth: 80 },
      { prop: 'status', label: '状态', minWidth: 90 },
    ],
    fields: [
      { name: 'code', label: '编码', required: true, placeholder: 'factory / subway / domestic', readonly: true },
      { name: 'name', label: '名称', required: true, placeholder: '工厂 / 地铁安检 / 保姆' },
      { name: 'sort_order', label: '排序', type: 'number' },
    ],
  },
  location: {
    label: '区域',
    resource: 'locations',
    searchPlaceholder: '搜索名称或地址...',
    columns: [
      { prop: 'level', label: '层级', minWidth: 100 },
      { prop: 'name', label: '名称', minWidth: 140 },
      { prop: 'parent_id', label: '上级', minWidth: 120, lookup: 'locations' },
      { prop: 'address', label: '地址', minWidth: 200 },
      { prop: 'walk_guide', label: '怎么走', minWidth: 220 },
      { prop: 'code', label: '编码', minWidth: 100 },
    ],
    fields: [
      { name: 'level', label: '层级', required: true, placeholder: 'province / city / district / park / point' },
      { name: 'name', label: '名称', required: true, placeholder: '番禺区 / 钟村工业区' },
      { name: 'parent_id', label: '上级区域', type: 'select', source: 'locations', allowEmpty: '（顶层）' },
      { name: 'address', label: '地址', placeholder: '广东省广州市番禺区钟村' },
      { name: 'walk_guide', label: '怎么走', type: 'textarea', placeholder: '地铁 2 号线 C 出口，电梯上 7 楼 A7-A8' },
      { name: 'code', label: '编码' },
    ],
  },
  employer: {
    label: '招工方',
    resource: 'employers',
    searchPlaceholder: '搜索编码、全名或简称...',
    columns: [
      { prop: 'employer_code', label: '编码', minWidth: 110 },
      { prop: 'display_name', label: '全名', minWidth: 240 },
      { prop: 'short_name', label: '简称', minWidth: 100 },
      { prop: 'vertical_id', label: '品类', minWidth: 110, lookup: 'verticals' },
      { prop: 'location_id', label: '所在地', minWidth: 110, lookup: 'locations' },
      { prop: 'aliases', label: '别名', minWidth: 160 },
    ],
    fields: [
      { name: 'employer_code', label: '编码', required: true, placeholder: 'GZ-PY-001', readonly: true },
      { name: 'display_name', label: '全名', required: true, placeholder: '松下万宝(广州)压缩机有限公司' },
      { name: 'short_name', label: '简称', placeholder: '松下' },
      { name: 'vertical_id', label: '品类', type: 'select', source: 'verticals', required: true },
      { name: 'location_id', label: '所在地', type: 'select', source: 'locations', allowEmpty: '（未指定）' },
      { name: 'aliases', label: '别名', type: 'list', placeholder: '客户口语，逗号分隔：松下,万宝' },
    ],
  },
}

const props = defineProps<{ kind: 'vertical' | 'location' | 'employer' }>()

const config = computed(() => CONFIGS[props.kind])
const rows = ref<Row[]>([])
const lookups = ref<{ locations: Row[]; verticals: Row[] }>({ locations: [], verticals: [] })
const loading = ref(false)
const saving = ref(false)
const keyword = ref('')
const page = ref(1)
const pageSize = ref(20)
const editorVisible = ref(false)
const editingId = ref<number | null>(null)
const draft = ref<Record<string, unknown>>({})

const filtered = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  if (!key) return rows.value
  return rows.value.filter((row) =>
    Object.values(row).some((value) => String(value ?? '').toLowerCase().includes(key)),
  )
})

const paged = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

watch([keyword], () => {
  page.value = 1
})

watch(
  () => props.kind,
  () => {
    keyword.value = ''
    page.value = 1
    void load()
  },
)

function lookupName(source: 'locations' | 'verticals', id: unknown): string {
  if (!id) return ''
  const hit = lookups.value[source].find((row) => Number(row.id) === Number(id))
  if (!hit) return `#${id}`
  return String(hit.short_name || hit.display_name || hit.name || hit.code || `#${id}`)
}

function selectOptions(field: Field): Array<{ value: number; label: string }> {
  const source = field.source ? lookups.value[field.source] : []
  return source.map((row) => ({
    value: Number(row.id),
    label: String(row.short_name || row.display_name || row.name || row.code || row.id),
  }))
}

function setDraft(name: string, value: unknown): void {
  draft.value[name] = value
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const tasks: Array<Promise<void>> = []
    if (props.kind === 'vertical') {
      tasks.push(listVerticals().then((items) => { rows.value = items as unknown as Row[] }))
    } else if (props.kind === 'location') {
      tasks.push(listLocations().then((items) => { rows.value = items as unknown as Row[] }))
    } else {
      tasks.push(listEmployers().then((items) => { rows.value = items as unknown as Row[] }))
    }
    if (props.kind !== 'vertical') {
      tasks.push(listVerticals().then((items) => { lookups.value.verticals = items as unknown as Row[] }))
    }
    if (props.kind === 'employer') {
      tasks.push(listLocations().then((items) => { lookups.value.locations = items as unknown as Row[] }))
    }
    await Promise.all(tasks)
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || `${config.value.label}加载失败`)
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  editingId.value = null
  draft.value = { status: 'enabled' }
  editorVisible.value = true
}

function openEdit(row: Row): void {
  editingId.value = Number(row.id)
  draft.value = { ...row }
  editorVisible.value = true
}

async function save(): Promise<void> {
  const payload: Record<string, unknown> = { ...draft.value }
  for (const field of config.value.fields) {
    if (field.required && (payload[field.name] === undefined || payload[field.name] === null || payload[field.name] === '')) {
      ElMessage.warning(`${field.label}必填`)
      return
    }
  }
  // 空引用统一存 0（与 kb-console 约定一致：0 = 不绑定）
  for (const key of Object.keys(payload)) {
    if (payload[key] === '' || payload[key] === null) payload[key] = 0
  }
  saving.value = true
  try {
    if (editingId.value) await kbResourceApi.update(config.value.resource, editingId.value, payload)
    else await kbResourceApi.create(config.value.resource, payload)
    ElMessage.success('已保存')
    editorVisible.value = false
    await load()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '保存失败')
  } finally {
    saving.value = false
  }
}

async function toggleStatus(row: Row): Promise<void> {
  const next = row.status === 'enabled' ? 'disabled' : 'enabled'
  try {
    await kbResourceApi.setStatus(config.value.resource, row.id, next)
    ElMessage.success(next === 'enabled' ? '已启用' : '已停用')
    await load()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '状态切换失败')
  }
}

async function removeRow(row: Row): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除${config.value.label}「${String(row.name || row.code || row.id)}」吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await kbResourceApi.remove(config.value.resource, row.id)
    ElMessage.success('已删除')
    await load()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '删除失败')
  }
}

onMounted(load)
</script>

<style scoped>
.entity-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.entity-search {
  width: 280px;
}

.wrap-cell {
  display: block;
  white-space: normal;
  line-height: 1.5;
  word-break: break-word;
  color: var(--bd-text-secondary, #5f6b7a);
}

.full {
  width: 100%;
}

.pager {
  display: flex;
  justify-content: flex-end;
  padding: 10px 0 0;
}
</style>
