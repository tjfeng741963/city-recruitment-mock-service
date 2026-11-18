<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">页面不存在</h2>
        <p class="page-desc">请检查地址是否正确，或从左侧菜单进入</p>
      </div>
    </div>
    <div class="table-wrapper">
      <el-empty description="404：没有这个页面">
        <el-button type="primary" @click="goHome">回到监控看板</el-button>
      </el-empty>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()

function goHome(): void {
  router.replace('/dashboard')
}
</script>
