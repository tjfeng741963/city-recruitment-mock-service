<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">主推设置</h2>
        <p class="page-desc">配置各城市对外展示的主推岗位（最多 {{ maxFeatured }} 个）</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ cities.length }}</div>
        <div class="stat-label">城市总数</div>
      </div>
      <div class="stat-card stat-active">
        <div class="stat-value">{{ configuredCount }}</div>
        <div class="stat-label">已配置主推</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ maxFeatured }}</div>
        <div class="stat-label">每城上限</div>
      </div>
    </div>

    <el-alert
      v-if="permissionDenied"
      title="主推设置仅对招聘员账号开放（当前账号无权限）"
      type="warning"
      show-icon
      :closable="false"
      class="page-alert"
    >
      <p class="alert-desc">
        后端接口 <code>GET /api/v1/recruiter-featured/cities</code> 仅允许 recruiter 角色访问。
        请使用招聘员账号（例如 <code>local-recruiter</code>）登录后再配置主推岗位。
      </p>
      <el-button size="small" @click="load">重新加载</el-button>
    </el-alert>

    <el-alert
      v-else-if="errorMessage"
      :title="errorMessage"
      type="error"
      show-icon
      :closable="false"
      class="page-alert"
    >
      <template #default>
        <el-button link type="primary" @click="load">重新加载</el-button>
      </template>
    </el-alert>

    <template v-if="!permissionDenied">
      <div class="filter-bar">
        <el-input
          v-model="keyword"
          class="search-input"
          placeholder="搜索城市名称..."
          clearable
          :prefix-icon="Search"
        />
        <el-select v-model="statusFilter" class="status-select" placeholder="主推状态" clearable>
          <el-option label="全部" value="" />
          <el-option label="已配置" value="configured" />
          <el-option label="未配置" value="default" />
        </el-select>
      </div>

      <div class="table-wrapper">
        <el-table v-loading="loading" :data="pagedCities" row-key="city_id">
          <template #empty>
            <el-empty description="暂无可配置城市" />
          </template>
          <el-table-column prop="city_name" label="城市" min-width="140" />
          <el-table-column label="主推状态" width="120">
            <template #default="{ row }">
              <el-tag :type="row.has_custom ? 'success' : 'info'" size="small" effect="light">
                {{ row.has_custom ? '已配置' : '默认' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="主推岗位" min-width="320">
            <template #default="{ row }">
              <div v-if="selectedPositions(row).length" class="position-tags">
                <el-tag
                  v-for="position in selectedPositions(row)"
                  :key="position.id"
                  size="small"
                  effect="plain"
                >
                  {{ position.position_name }}
                </el-tag>
              </div>
              <span v-else class="muted">未配置（使用默认主推）</span>
            </template>
          </el-table-column>
          <el-table-column label="可选岗位" width="100" align="center">
            <template #default="{ row }">
              <span class="muted">{{ row.positions?.length ?? 0 }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
              <el-button
                link
                type="danger"
                :disabled="!row.has_custom"
                @click="removeFeatured(row)"
              >
                移除
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="pager">
          <el-pagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :page-sizes="[10, 20, 50]"
            :total="filteredCities.length"
            layout="total, sizes, prev, pager, next, jumper"
          />
        </div>
      </div>
    </template>

    <FeaturedCityDialog
      v-model="dialogVisible"
      :city="activeCity"
      :max-featured="maxFeatured"
      @saved="load"
    />
  </section>
</template>

<script setup lang="ts">
import {  computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Search } from '@element-plus/icons-vue'
import {
  apiErrorMessage,
  featuredApi,
  type FeaturedCity,
  type FeaturedPosition,
} from '../api/system'
import { toArray } from '../utils/format'
import FeaturedCityDialog from '../components/system/FeaturedCityDialog.vue'

const cities = ref<FeaturedCity[]>([])
const maxFeatured = ref(3)
const loading = ref(false)
const errorMessage = ref('')
const permissionDenied = ref(false)
const keyword = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)

const dialogVisible = ref(false)
const activeCity = ref<FeaturedCity | null>(null)

const configuredCount = computed(() => cities.value.filter((city) => city.has_custom).length)

const filteredCities = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return cities.value.filter((city) => {
    if (statusFilter.value === 'configured' && !city.has_custom) return false
    if (statusFilter.value === 'default' && city.has_custom) return false
    if (key && !city.city_name.toLowerCase().includes(key)) return false
    return true
  })
})

const pagedCities = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredCities.value.slice(start, start + pageSize.value)
})


// 筛选变化时回到第 1 页，避免停在空页
watch([[keyword], [statusFilter]], () => {
  page.value = 1
})

function selectedPositions(row: FeaturedCity): FeaturedPosition[] {
  const ids = Array.isArray(row.position_ids) ? row.position_ids : []
  if (!ids.length) return []
  const map = new Map((row.positions || []).map((position) => [position.id, position]))
  return ids.map((id) => map.get(id)).filter((item): item is FeaturedPosition => Boolean(item))
}

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  permissionDenied.value = false
  try {
    const { data } = await featuredApi.list()
    cities.value = toArray<FeaturedCity>(data)
    maxFeatured.value = Number(data.max_featured ?? 3) || 3
  } catch (error: any) {
    cities.value = []
    if (error?.response?.status === 403) {
      permissionDenied.value = true
    } else {
      errorMessage.value = apiErrorMessage(error, '主推城市加载失败')
    }
  } finally {
    loading.value = false
  }
}

function openEdit(row: FeaturedCity): void {
  activeCity.value = row
  dialogVisible.value = true
}

async function removeFeatured(row: FeaturedCity): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定移除「${row.city_name}」的主推配置吗？移除后将恢复默认主推。`,
      '移除确认',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await featuredApi.remove(row.city_id)
    ElMessage.success('主推配置已移除')
    await load()
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '移除失败'))
  }
}

onMounted(load)
</script>

<style scoped>
.search-input {
  width: 260px;
}

.status-select {
  width: 150px;
}

.page-alert {
  margin-bottom: 16px;
}

.alert-desc {
  margin: 6px 0 10px;
  font-size: 12.5px;
  line-height: 1.7;
}

.position-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
