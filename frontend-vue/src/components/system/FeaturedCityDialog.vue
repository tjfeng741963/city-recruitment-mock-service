<template>
  <el-dialog
    :model-value="modelValue"
    :title="`编辑主推 · ${city?.city_name || ''}`"
    width="560px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="init"
  >
    <p class="dialog-desc">
      选择该城市对外展示的主推岗位，最多 <strong>{{ maxFeatured }}</strong> 个。取消全部选择等于恢复默认。
    </p>

    <div v-if="!positions.length" class="empty-wrap">
      <el-empty description="该城市暂无启用岗位，无法设置主推" :image-size="80" />
    </div>
    <el-form v-else label-position="top">
      <el-form-item :label="`主推岗位（已选 ${selected.length} / ${maxFeatured}）`">
        <el-select
          v-model="selected"
          class="full"
          multiple
          filterable
          clearable
          :multiple-limit="maxFeatured"
          placeholder="选择岗位"
        >
          <el-option
            v-for="position in positions"
            :key="position.id"
            :label="position.position_name"
            :value="position.id"
          />
        </el-select>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!positions.length" @click="submit">
        保存
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { apiErrorMessage, featuredApi, type FeaturedCity } from '../../api/system'

const props = defineProps<{
  modelValue: boolean
  city: FeaturedCity | null
  maxFeatured: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved'): void
}>()

const saving = ref(false)
const selected = ref<number[]>([])

const positions = computed(() => (Array.isArray(props.city?.positions) ? props.city!.positions! : []))

function init(): void {
  selected.value = Array.isArray(props.city?.position_ids) ? [...props.city!.position_ids!] : []
}

async function submit(): Promise<void> {
  if (!props.city) return
  saving.value = true
  try {
    await featuredApi.save(props.city.city_id, selected.value)
    ElMessage.success('主推岗位已保存')
    emit('update:modelValue', false)
    emit('saved')
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '主推保存失败'))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.dialog-desc {
  margin: 0 0 16px;
  color: var(--bd-text-tertiary);
  font-size: 13px;
  line-height: 1.6;
}

.dialog-desc strong {
  color: var(--bd-text-primary);
}

.empty-wrap {
  padding: 6px 0 12px;
}

.full {
  width: 100%;
}
</style>
