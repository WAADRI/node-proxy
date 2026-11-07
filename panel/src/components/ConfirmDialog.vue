<script setup>
import { ref, watch } from 'vue';
import { NModal, NButton, NCheckbox } from 'naive-ui';
import AppIcon from './AppIcon.vue';

const props = defineProps({
  show: { type: Boolean, default: false },
  title: { type: String, default: '请确认操作' },
  message: { type: String, default: '' },
  danger: { type: Boolean, default: true },
  requireCheck: { type: Boolean, default: false },
  checkLabel: { type: String, default: '我了解该操作的影响' },
  okText: { type: String, default: '确认' },
});
const emit = defineEmits(['update:show', 'ok', 'cancel']);

const checked = ref(false);
watch(
  () => props.show,
  (v) => {
    if (v) checked.value = false;
  }
);

function cancel() {
  emit('update:show', false);
  emit('cancel');
}
function ok() {
  emit('update:show', false);
  emit('ok');
}
</script>

<template>
  <NModal
    :show="props.show"
    :on-update:show="(v) => !v && cancel()"
    preset="card"
    :style="{ width: '440px', maxWidth: '92vw' }"
    :title="null"
  >
    <div class="np-confirm">
      <div class="np-confirm-head" :class="props.danger ? 'danger' : ''">
        <AppIcon :name="props.danger ? 'alert' : 'refresh'" :size="18" />
        <span>{{ props.title }}</span>
      </div>
      <div class="np-confirm-msg">{{ props.message }}</div>
      <NCheckbox v-if="props.requireCheck" v-model:checked="checked" class="np-confirm-check">
        {{ props.checkLabel }}
      </NCheckbox>
      <div class="np-confirm-actions">
        <NButton size="small" @click="cancel">取消</NButton>
        <NButton
          size="small"
          :type="props.danger ? 'error' : 'primary'"
          :disabled="props.requireCheck && !checked"
          @click="ok"
        >
          {{ props.okText }}
        </NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.np-confirm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
}
.np-confirm-head.danger { color: var(--np-danger); }
.np-confirm-msg {
  font-size: 13px;
  color: var(--np-text-2);
  margin-bottom: 12px;
  line-height: 1.6;
  white-space: pre-line;
}
.np-confirm-check { margin-bottom: 16px; }
.np-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
