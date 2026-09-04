<script setup>
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: '-' },
  unit: { type: String, default: '' },
  hint: { type: String, default: '' },
  accent: { type: Boolean, default: false },
});
</script>

<template>
  <div class="np-stat" :title="hint">
    <div class="np-stat-label">{{ label }}</div>
    <div class="np-stat-value" :class="{ accent }">
      {{ value }}<span v-if="unit" class="np-stat-unit">{{ unit }}</span>
    </div>
  </div>
</template>

<style scoped>
.np-stat {
  background: var(--np-bg-soft);
  border: 1px solid var(--np-border-soft);
  border-radius: 10px;
  padding: 14px 16px;
}
.np-stat-label {
  font-size: 12px;
  color: var(--np-text-muted);
  margin-bottom: 6px;
}
.np-stat-value {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  display: flex;
  align-items: baseline;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.np-stat-value.accent {
  color: var(--np-primary);
  font-size: 19px;
}
.np-stat-unit {
  font-size: 12px;
  color: var(--np-text-muted);
  font-weight: 400;
}
</style>
