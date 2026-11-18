<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">{{ title }}</h2>
        <p class="page-desc">该页面已纳入重构清单，当前版本先完成登录、城市管理与岗位管理三块校准。</p>
      </div>
    </div>
    <div class="table-wrapper placeholder-card">
      <el-empty description="页面迁移中" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const title = computed(() => String(route.meta.title || '功能迁移中'))
</script>

<style scoped>
.placeholder-card {
  padding: 48px;
}
</style>
