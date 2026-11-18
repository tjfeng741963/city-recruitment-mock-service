<template>
  <div class="login-page">
    <div class="login-bg" data-rk-ready="1">
      <div class="bg-shape shape-1" />
      <div class="bg-shape shape-2" />
      <div class="bg-shape shape-3" />
      <div class="bg-shape shape-4" />
      <img class="rk-skyline" src="/theme/skyline.svg" alt="" aria-hidden="true" />
    </div>

    <section class="rk-login-hero">
      <div class="rk-hero-eyebrow">
        <span class="rk-hero-dot" />
        City Recruitment Platform
      </div>
      <h1 class="rk-hero-title">
        让每一座城市的岗位<br />
        <span class="rk-hero-grad">找到对的人</span>
      </h1>
      <p class="rk-hero-desc">
        城市、工厂、岗位与招聘对话，在一个控制台里统一配置与追踪。
      </p>
      <ul class="rk-hero-tags">
        <li>城市配置</li>
        <li>工厂岗位</li>
        <li>智能对话</li>
        <li>数据看板</li>
      </ul>
    </section>

    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">
          <div class="logo-icon">C</div>
        </div>
        <h1 class="login-title">城市招聘配置管理</h1>
        <p class="login-subtitle">City Recruitment Configuration</p>
      </div>

      <el-form class="login-form" @submit.prevent="handleSubmit">
        <el-form-item>
          <el-input
            v-model="form.username"
            size="large"
            placeholder="请输入用户名"
            autocomplete="off"
            :prefix-icon="User"
          />
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="form.password"
            size="large"
            type="password"
            placeholder="请输入密码"
            autocomplete="off"
            show-password
            :prefix-icon="Lock"
            @keyup.enter="handleSubmit"
          />
        </el-form-item>
        <el-form-item>
          <el-button
            class="login-btn"
            type="primary"
            size="large"
            native-type="submit"
            :loading="auth.loading"
          >
            登录
          </el-button>
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Lock, User } from '@element-plus/icons-vue'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const form = reactive({ username: '', password: '' })

async function handleSubmit(): Promise<void> {
  if (!form.username.trim() || !form.password) {
    ElMessage.warning('请输入用户名和密码')
    return
  }
  try {
    await auth.login(form.username.trim(), form.password)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/cities'
    await router.replace(redirect)
  } catch (error: any) {
    const detail = error?.response?.data?.detail || error?.message || '登录失败'
    ElMessage.error(typeof detail === 'string' ? detail : '登录失败')
  }
}
</script>
