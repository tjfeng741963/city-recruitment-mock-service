<template>
  <div class="chart-card">
    <div class="chart-head">
      <h3 class="card-title">
        {{ title }}
        <span v-if="subtitle" class="card-subtitle">{{ subtitle }}</span>
      </h3>
      <slot name="extra" />
    </div>
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
}>()
</script>

<style scoped>
.chart-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 20px;
}

.chart-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.card-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  margin: 0;
  color: var(--bd-text-primary);
  font-size: 14px;
  font-weight: 600;
}

.card-subtitle {
  color: #909399;
  font-size: 12px;
  font-weight: 400;
}
</style>
