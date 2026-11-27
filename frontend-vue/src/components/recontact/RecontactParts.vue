<template>
  <section class="parts">
    <div class="parts-heading">
      <h3>发送内容</h3>
      <el-button :icon="Plus" :disabled="disabled || model.length >= 12" @click="addPart">添加消息</el-button>
    </div>
    <p v-if="model.length === 0" class="empty-parts">添加第一条消息</p>
    <ol class="part-list">
      <li v-for="(part, index) in model" :key="index" class="part-row">
        <div class="part-heading">
          <span class="part-step">第 {{ index + 1 }} 条</span>
          <el-select :model-value="part.kind" :disabled="disabled" :aria-label="`第 ${index + 1} 条消息类型`"
            class="part-kind" @update:model-value="changeKind(index, $event)">
            <el-option v-for="item in kinds" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <div class="part-actions">
            <el-button :icon="ArrowUp" :disabled="disabled || index === 0" aria-label="上移消息"
              title="上移消息" @click="model = reorderParts(model, index, -1)" />
            <el-button :icon="ArrowDown" :disabled="disabled || index === model.length - 1" aria-label="下移消息"
              title="下移消息" @click="model = reorderParts(model, index, 1)" />
            <el-button :icon="Delete" :disabled="disabled" aria-label="删除消息"
              title="删除消息" @click="model = model.filter((_, itemIndex) => itemIndex !== index)" />
          </div>
        </div>
        <el-input v-if="part.kind === 'text'" :model-value="part.value" type="textarea" :rows="2"
          :maxlength="2000" :disabled="disabled" placeholder="输入招聘话术"
          aria-label="招聘话术" @update:model-value="replacePart(index, { value: $event })" />
        <el-select v-else-if="part.kind === 'location'" :model-value="part.value"
          class="part-value" :disabled="disabled" filterable placeholder="选择岗位地点" aria-label="岗位地点"
          @update:model-value="replacePart(index, { value: $event })">
          <el-option v-for="location in locations" :key="location.key" :value="location.key"
            :label="location.name" :disabled="!location.mappable">
            {{ location.name }} · {{ location.address }}{{ location.mappable ? '' : '（缺少导航坐标）' }}
          </el-option>
        </el-select>
        <el-select v-else :model-value="part.value" class="part-value"
          :disabled="disabled" filterable placeholder="选择素材" aria-label="图片或视频素材"
          @update:model-value="replacePart(index, { value: $event })">
          <el-option v-for="asset in assets.filter(item => item.kind === part.kind)" :key="asset.name"
            :label="asset.name" :value="asset.name" />
        </el-select>
        <label v-if="index > 0" class="part-delay">
          <span>与上一条间隔</span>
          <el-input-number :model-value="part.delay_ms / 1000" :min="0" :max="600"
            :step="0.5" :precision="1" :disabled="disabled" aria-label="与上一条消息间隔秒数"
            @update:model-value="replacePart(index, { delay_ms: Math.round(($event ?? 0) * 1000) })" />
          <span>秒</span>
        </label>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { ArrowDown, ArrowUp, Delete, Plus } from '@element-plus/icons-vue'
import type { RecontactKind, RecontactOptions, RecontactPart } from '../../api/recontact'
import { reorderParts } from './recontact-view'

defineProps<{
  assets: RecontactOptions['assets']
  locations: RecontactOptions['locations']
  disabled?: boolean
}>()
const model = defineModel<RecontactPart[]>({ required: true })
const kinds: { label: string; value: RecontactKind }[] = [
  { label: '文字', value: 'text' },
  { label: '图片', value: 'image' },
  { label: '视频', value: 'video' },
  { label: '地点链接', value: 'location' },
]

function addPart() {
  model.value = [...model.value, { kind: 'text', value: '', delay_ms: model.value.length ? 2000 : 0 }]
}

function replacePart(index: number, patch: Partial<RecontactPart>) {
  model.value = model.value.map((part, i) => i === index ? { ...part, ...patch } : part)
}

function changeKind(index: number, kind: RecontactKind) {
  replacePart(index, { kind, value: '' })
}
</script>

<style scoped>
.parts-heading, .part-heading, .part-actions, .part-delay { display: flex; align-items: center; gap: 10px; }
.parts-heading { justify-content: space-between; }
h3 { margin: 0; font-size: 15px; }
.empty-parts { color: var(--bd-text-secondary, #59677e); }
.part-list { display: grid; gap: 12px; padding: 0; margin: 12px 0 0; list-style: none; }
.part-row { display: grid; gap: 12px; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 8px; min-width: 0; }
.part-heading { flex-wrap: wrap; }
.part-step { flex: 0 0 auto; font-weight: 600; }
.part-kind { width: 124px; }
.part-value { width: 100%; }
.part-actions { margin-inline-start: auto; gap: 6px; }
.part-actions :deep(.el-button + .el-button) { margin-left: 0; }
.part-delay { flex-wrap: wrap; font-size: 13px; }
.part-delay :deep(.el-input-number) { width: 110px; }
@media (max-width: 550px) {
  .part-actions { margin-inline-start: 0; }
}
</style>
