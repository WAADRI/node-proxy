<script setup>
import AppIcon from './AppIcon.vue';

defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: '-' },
  unit: { type: String, default: '' },
  hint: { type: String, default: '' },
  icon: { type: String, default: 'chart' },
  tone: { type: String, default: 'primary' }, // primary | violet | cyan | success | warning | danger
  accent: { type: Boolean, default: false },
});
</script>

<template>
  <div class="np-stat" :class="'tone-' + tone" :title="hint">
    <div class="np-stat-head">
      <span class="np-stat-icon"><AppIcon :name="icon" :size="15" /></span>
      <span class="np-stat-label">{{ label }}</span>
    </div>
    <div class="np-stat-value" :class="{ accent }">
      <span class="np-stat-number">{{ value }}</span>
      <span v-if="unit" class="np-stat-unit">{{ unit }}</span>
    </div>
    <span class="np-stat-glow" aria-hidden="true"></span>
  </div>
</template>

<style scoped>
.np-stat {
  position: relative;
  overflow: hidden;
  background: var(--np-panel-bg);
  border: 1px solid var(--np-border-soft);
  border-radius: 14px;
  padding: 14px 16px 15px;
  min-width: 0;
  box-shadow: var(--np-shadow);
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease;
}
.np-stat:hover {
  transform: translateY(-2px);
  border-color: rgba(var(--stat-rgb), 0.34);
  box-shadow: 0 14px 34px rgba(var(--stat-rgb), 0.12);
}
.np-stat::before {
  content: '';
  position: absolute;
  inset: 0 auto auto 0;
  width: 100%;
  height: 2px;
  background: linear-gradient(90deg, rgba(var(--stat-rgb), 0.9), rgba(var(--stat-rgb), 0));
  opacity: 0.8;
}
.np-stat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
}
.np-stat-icon {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  color: rgb(var(--stat-rgb));
  background: rgba(var(--stat-rgb), 0.1);
  border: 1px solid rgba(var(--stat-rgb), 0.16);
}
.np-stat-label {
  font-size: 12px;
  color: var(--np-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.np-stat-value {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.np-stat-number {
  font-size: 23px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
}
.np-stat-value.accent .np-stat-number {
  color: rgb(var(--stat-rgb));
  font-size: 19px;
}
.np-stat-unit {
  font-size: 11.5px;
  color: var(--np-text-muted);
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.np-stat-glow {
  position: absolute;
  right: -28px;
  bottom: -34px;
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: rgba(var(--stat-rgb), 0.08);
  filter: blur(10px);
  pointer-events: none;
}

.tone-primary { --stat-rgb: var(--np-primary-rgb); }
.tone-violet { --stat-rgb: var(--np-violet-rgb); }
.tone-cyan { --stat-rgb: var(--np-cyan-rgb); }
.tone-success { --stat-rgb: var(--np-success-rgb); }
.tone-warning { --stat-rgb: var(--np-warning-rgb); }
.tone-danger { --stat-rgb: var(--np-danger-rgb); }
</style>
