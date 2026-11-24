<template>
  <el-dialog
    :model-value="modelValue"
    title="导入 / 导出"
    width="640px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <el-tabs v-model="activeTab">
      <el-tab-pane label="岗位导入/导出" name="positions">
        <div class="block">
          <div class="block-title">导出</div>
          <div class="block-actions">
            <el-button :icon="Download" :loading="exporting" @click="exportPositions">导出岗位</el-button>
            <el-button :icon="Document" @click="downloadTemplate">下载导入模板</el-button>
          </div>
          <p class="hint">Excel 导出仅含岗位索引。</p>
        </div>
        <el-divider />
        <div class="block">
          <div class="block-title">导入</div>
          <el-upload
            :auto-upload="false"
            :disabled="!importAvailable"
            :limit="1"
            accept=".xlsx,.xls"
            :on-change="onPick"
            :on-remove="() => (file = null)"
            :file-list="fileList"
          >
            <el-button :icon="Upload">选择 Excel 文件</el-button>
          </el-upload>
          <el-button
            class="mt"
            type="primary"
            :loading="importing"
            :disabled="!importAvailable || !file"
            @click="importPositions"
          >
            开始导入
          </el-button>
          <p v-if="!importAvailable" class="hint">暂不支持导入</p>
        </div>
      </el-tab-pane>

      <el-tab-pane label="鲸才岗位导入" name="jingcai">
        <el-form label-width="100px">
          <el-form-item label="招聘员 ID">
            <el-input v-model="recruiterId" placeholder="留空则使用当前账号" />
          </el-form-item>
        </el-form>
        <el-upload
          :auto-upload="false"
          :disabled="!importAvailable"
          :limit="1"
          accept=".xlsx,.xls"
          :on-change="onJingcaiPick"
          :on-remove="() => (jingcaiFile = null)"
          :file-list="jingcaiList"
        >
          <el-button :icon="Upload">选择鲸才表格</el-button>
        </el-upload>
        <el-button
          class="mt"
          type="primary"
          :loading="importing"
          :disabled="!importAvailable || !jingcaiFile"
          @click="importJingcai"
        >
          开始导入
        </el-button>
        <p v-if="!importAvailable" class="hint">暂不支持导入</p>
      </el-tab-pane>

      <el-tab-pane label="岗位节假日" name="holidays">
        <div class="block">
          <div class="block-title">导出</div>
          <el-button :icon="Download" :loading="exporting" @click="exportHolidays">导出岗位假期</el-button>
        </div>
        <el-divider />
        <div class="block">
          <div class="block-title">导入</div>
          <el-upload
            :auto-upload="false"
            :disabled="!importAvailable"
            :limit="1"
            accept=".xlsx,.xls"
            :on-change="onHolidayPick"
            :on-remove="() => (holidayFile = null)"
            :file-list="holidayList"
          >
            <el-button :icon="Upload">选择假期表格</el-button>
          </el-upload>
          <el-button
            class="mt"
            type="primary"
            :loading="importing"
            :disabled="!importAvailable || !holidayFile"
            @click="importHolidays"
          >
            开始导入
          </el-button>
          <p v-if="!importAvailable" class="hint">暂不支持导入</p>
        </div>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { Document, Download, Upload } from '@element-plus/icons-vue'
import { positionsApi, transferApi, apiErrorMessage } from '../../api/core'
import { downloadBlob } from '../../utils/format'

defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'imported'): void
}>()

// These import endpoints currently accept files without writing any records.
const importAvailable = false
const activeTab = ref('positions')
const exporting = ref(false)
const importing = ref(false)
const file = ref<File | null>(null)
const jingcaiFile = ref<File | null>(null)
const holidayFile = ref<File | null>(null)
const fileList = ref<UploadFile[]>([])
const jingcaiList = ref<UploadFile[]>([])
const holidayList = ref<UploadFile[]>([])
const recruiterId = ref('')

function pick(event: { raw?: File } | UploadFile, target: typeof file): void {
  const raw = (event as UploadFile).raw
  if (raw) target.value = raw as File
}

function onPick(up: UploadFile): void {
  fileList.value = [up]
  pick(up, file)
}

function onJingcaiPick(up: UploadFile): void {
  jingcaiList.value = [up]
  pick(up, jingcaiFile)
}

function onHolidayPick(up: UploadFile): void {
  holidayList.value = [up]
  pick(up, holidayFile)
}

function reportResult(result?: { total?: number; created?: number; updated?: number }): void {
  if (!result) return
  const total = result.total ?? 0
  const created = result.created ?? 0
  const updated = result.updated ?? 0
  ElMessage.success(`导入完成：共 ${total} 条，新增 ${created} 条，更新 ${updated} 条`)
}

async function exportPositions(): Promise<void> {
  exporting.value = true
  try {
    const { data } = await transferApi.exportPositions()
    downloadBlob(data, '岗位导出.xlsx')
    ElMessage.success('已开始下载岗位导出文件')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '导出失败'))
  } finally {
    exporting.value = false
  }
}

async function downloadTemplate(): Promise<void> {
  try {
    const { data } = await transferApi.template()
    downloadBlob(data, '导入模板.xlsx')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '模板下载失败'))
  }
}

async function importPositions(): Promise<void> {
  if (!importAvailable || !file.value) return
  importing.value = true
  try {
    const form = new FormData()
    form.append('file', file.value)
    const { data } = await transferApi.importPositions(form)
    reportResult(data)
    file.value = null
    fileList.value = []
    emit('imported')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '导入失败'))
  } finally {
    importing.value = false
  }
}

async function importJingcai(): Promise<void> {
  if (!importAvailable || !jingcaiFile.value) return
  importing.value = true
  try {
    const form = new FormData()
    form.append('file', jingcaiFile.value)
    const { data } = await positionsApi.jingcaiImport(form, recruiterId.value.trim() || undefined)
    reportResult(data)
    jingcaiFile.value = null
    jingcaiList.value = []
    emit('imported')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '鲸才导入失败'))
  } finally {
    importing.value = false
  }
}

async function exportHolidays(): Promise<void> {
  exporting.value = true
  try {
    const { data } = await positionsApi.holidaysExport()
    downloadBlob(data, '岗位假期导出.xlsx')
    ElMessage.success('已开始下载岗位假期文件')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '导出失败'))
  } finally {
    exporting.value = false
  }
}

async function importHolidays(): Promise<void> {
  if (!importAvailable || !holidayFile.value) return
  importing.value = true
  try {
    const form = new FormData()
    form.append('file', holidayFile.value)
    const { data } = await positionsApi.holidaysImport(form)
    reportResult(data)
    holidayFile.value = null
    holidayList.value = []
    emit('imported')
  } catch (error: any) {
    ElMessage.error(apiErrorMessage(error, '假期导入失败'))
  } finally {
    importing.value = false
  }
}
</script>

<style scoped>
.block-title {
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--bd-text-primary);
}

.block-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--bd-text-tertiary);
}

.mt {
  margin-top: 12px;
}
</style>
