<template>
  <el-dialog
    :model-value="modelValue"
    title="模板包"
    width="820px"
    destroy-on-close
    @update:model-value="close"
  >
    <div v-loading="loading" class="kb-template-dialog">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="一键导入通用问答包"
        description="已存在的同问题会自动跳过，不会覆盖运营修改过的内容。"
      />

      <el-alert
        v-if="error"
        class="kb-template-alert"
        type="error"
        :closable="false"
        show-icon
        :title="error"
      />

      <el-alert
        v-if="result"
        class="kb-template-alert"
        type="success"
        :closable="false"
        show-icon
        :title="`导入完成：新增 ${result.imported} 条，跳过 ${result.skipped} 条`"
      >
        <template #default>
          <div class="kb-template-result">
            <p>新增 {{ result.imported }} 条，跳过 {{ result.skipped }} 条。</p>
            <div v-if="result.blocked.length" class="kb-template-blocked">
              <p>以下 {{ result.blocked.length }} 条未通过治理校验：</p>
              <ul>
                <li v-for="item in result.blocked" :key="item.id">
                  {{ item.question }} —— {{ item.detail }}
                </li>
              </ul>
            </div>
          </div>
        </template>
      </el-alert>

      <el-table :data="templates" max-height="420">
        <el-table-column prop="name" label="模板名称" min-width="180" />
        <el-table-column prop="code" label="编码" min-width="140" />
        <el-table-column prop="vertical_code" label="适用品类" width="110" />
        <el-table-column label="条目数" width="90">
          <template #default="{ row }">{{ row.item_count }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag type="success" effect="light">{{ row.status || 'published' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :loading="importingCode === row.code" @click="importTemplate(row)">
              一键导入
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无模板包" :image-size="90" />
        </template>
      </el-table>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="close(false)">关闭</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  importKbTemplate,
  knowledgeErrorMessage,
  listKbTemplates,
  type KbTemplate,
} from '../../api/knowledge'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'imported'): void
}>()

const loading = ref(false)
const importingCode = ref('')
const error = ref('')
const templates = ref<KbTemplate[]>([])
const result = ref<{ imported: number; skipped: number; blocked: Array<{ id: string; question: string; detail: string }> } | null>(null)

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  result.value = null
  try {
    templates.value = await listKbTemplates()
  } catch (err) {
    error.value = knowledgeErrorMessage(err, '模板加载失败')
  } finally {
    loading.value = false
  }
}

async function importTemplate(template: KbTemplate): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将导入「${template.name}」的 ${template.item_count} 条问答，已存在的问题会自动跳过。是否继续？`,
      '导入模板',
      { type: 'warning', confirmButtonText: '开始导入', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  importingCode.value = template.code
  error.value = ''
  result.value = null
  try {
    const data = await importKbTemplate(template.code)
    const blocked = Array.isArray(data.blocked)
      ? (data.blocked as Array<Record<string, unknown>>).map((item) => ({
        id: String(item.id ?? ''),
        question: String(item.question ?? ''),
        detail: String(item.detail ?? ''),
      }))
      : []
    result.value = {
      imported: Number(data.imported ?? 0),
      skipped: Number(data.skipped ?? 0),
      blocked,
    }
    ElMessage.success(`导入完成：新增 ${result.value.imported} 条`)
    emit('imported')
  } catch (err) {
    error.value = knowledgeErrorMessage(err, '模板导入失败')
    ElMessage.error(error.value)
  } finally {
    importingCode.value = ''
  }
}

function close(value = false): void {
  emit('update:modelValue', value)
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) void load()
  },
)
</script>

<style scoped>
.kb-template-dialog {
  min-height: 180px;
}

.kb-template-alert {
  margin-top: 12px;
}

.kb-template-result {
  font-size: 13px;
}

.kb-template-result p {
  margin: 2px 0;
}

.kb-template-blocked ul {
  margin: 4px 0 0;
  padding-left: 18px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
}
</style>
