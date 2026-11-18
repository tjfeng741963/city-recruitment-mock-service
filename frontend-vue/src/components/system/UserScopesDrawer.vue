<template>
  <el-drawer
    :model-value="modelValue"
    :title="`权限范围${user ? ' · ' + user.username : ''}`"
    size="560px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="load"
  >
    <div v-loading="loading">
      <p class="drawer-desc">
        为用户指定可访问的招聘员、城市与坐席设备。管理员默认拥有全部数据范围，这里的配置对管理员不生效。
      </p>

      <el-alert
        v-if="errorMessage"
        :title="errorMessage"
        type="error"
        show-icon
        :closable="false"
        class="drawer-alert"
      />

      <el-alert
        v-if="staleScopes.length"
        :title="`存在已失效的范围：${staleScopes.join('、')}，保存时将自动忽略`"
        type="warning"
        show-icon
        :closable="false"
        class="drawer-alert"
      />

      <el-form label-position="top">
        <el-form-item :label="`招聘员（已选 ${scopeRecruiters.length}）`">
          <el-select
            v-model="scopeRecruiters"
            class="full"
            multiple
            filterable
            clearable
            collapse-tags
            collapse-tags-tooltip
            placeholder="选择招聘员"
          >
            <el-option
              v-for="item in recruiters"
              :key="item.recruiter_id"
              :label="`${item.name}（${item.recruiter_id}）`"
              :value="item.recruiter_id"
            />
          </el-select>
        </el-form-item>

        <el-form-item :label="`城市（已选 ${scopeCities.length}）`">
          <el-select
            v-model="scopeCities"
            class="full"
            multiple
            filterable
            clearable
            collapse-tags
            collapse-tags-tooltip
            placeholder="选择城市"
          >
            <el-option
              v-for="city in cityOptions"
              :key="city.id"
              :label="city.city_name"
              :value="String(city.id)"
            />
          </el-select>
        </el-form-item>

        <el-form-item :label="`坐席设备（已选 ${scopeDevices.length}）`">
          <el-select
            v-model="scopeDevices"
            class="full"
            multiple
            filterable
            clearable
            collapse-tags
            collapse-tags-tooltip
            placeholder="选择设备编码"
          >
            <el-option
              v-for="device in deviceOptions"
              :key="device.device_code"
              :label="device.name ? `${device.name}（${device.device_code}）` : device.device_code"
              :value="device.device_code"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <div class="drawer-footer">
        <el-button @click="emit('update:modelValue', false)">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存权限</el-button>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  apiErrorMessage,
  recruitersApi,
  usersApi,
  type CityOption,
  type DeviceOption,
  type ScopeType,
  type UserItem,
  type UserScope,
} from '../../api/system'
import { toArray } from '../../utils/format'
import type { Recruiter } from '../../api/types'

const props = defineProps<{
  modelValue: boolean
  user: UserItem | null
  recruiters: Recruiter[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved'): void
}>()

const loading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const scopeRecruiters = ref<string[]>([])
const scopeCities = ref<string[]>([])
const scopeDevices = ref<string[]>([])
const cityOptions = ref<CityOption[]>([])
const deviceOptions = ref<DeviceOption[]>([])

const validRecruiters = computed(
  () => new Set(props.recruiters.map((item) => item.recruiter_id)),
)
const validCities = computed(() => new Set(cityOptions.value.map((item) => String(item.id))))
const validDevices = computed(() => new Set(deviceOptions.value.map((item) => item.device_code)))

/** 已失效（后端已不存在）的范围，保存时会被忽略，否则整批保存会 422 */
const staleScopes = computed(() => {
  const stale: string[] = []
  for (const id of scopeRecruiters.value) {
    if (props.recruiters.length && !validRecruiters.value.has(id)) stale.push(`招聘员 ${id}`)
  }
  for (const id of scopeCities.value) {
    if (cityOptions.value.length && !validCities.value.has(id)) stale.push(`城市 ${id}`)
  }
  for (const id of scopeDevices.value) {
    if (deviceOptions.value.length && !validDevices.value.has(id)) stale.push(`设备 ${id}`)
  }
  return stale
})

function applyScopes(scopes: UserScope[]): void {
  scopeRecruiters.value = scopes.filter((s) => s.type === 'recruiter').map((s) => s.id)
  scopeCities.value = scopes.filter((s) => s.type === 'city').map((s) => s.id)
  scopeDevices.value = scopes.filter((s) => s.type === 'device').map((s) => s.id)
}

async function load(): Promise<void> {
  if (!props.user) return
  loading.value = true
  errorMessage.value = ''
  try {
    const [scopeResult, cityResult, deviceResult] = await Promise.all([
      usersApi.scopes(props.user.id),
      recruitersApi.cityOptions(),
      usersApi.deviceOptions(),
    ])
    applyScopes(Array.isArray(scopeResult.data?.scopes) ? scopeResult.data.scopes : [])
    cityOptions.value = toArray<CityOption>(cityResult.data)
    deviceOptions.value = toArray<DeviceOption>(deviceResult.data)
  } catch (error) {
    errorMessage.value = apiErrorMessage(error, '权限范围加载失败')
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (!props.user) return
  const recruiters =
    props.recruiters.length > 0
      ? scopeRecruiters.value.filter((id) => validRecruiters.value.has(id))
      : scopeRecruiters.value
  const cities =
    cityOptions.value.length > 0
      ? scopeCities.value.filter((id) => validCities.value.has(id))
      : scopeCities.value
  const devices =
    deviceOptions.value.length > 0
      ? scopeDevices.value.filter((id) => validDevices.value.has(id))
      : scopeDevices.value

  const scopes: UserScope[] = [
    ...recruiters.map((id) => ({ type: 'recruiter' as ScopeType, id })),
    ...cities.map((id) => ({ type: 'city' as ScopeType, id })),
    ...devices.map((id) => ({ type: 'device' as ScopeType, id })),
  ]
  saving.value = true
  try {
    await usersApi.saveScopes(props.user.id, scopes)
    ElMessage.success(staleScopes.value.length ? '权限范围已保存（已忽略失效范围）' : '权限范围已保存')
    emit('update:modelValue', false)
    emit('saved')
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '权限保存失败'))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.drawer-desc {
  margin: 0 0 18px;
  color: var(--bd-text-tertiary);
  font-size: 13px;
  line-height: 1.6;
}

.drawer-alert {
  margin-bottom: 12px;
}

.drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}

.full {
  width: 100%;
}
</style>
