<script setup>
import { ref } from 'vue';
import { NModal, NButton, NInput } from 'naive-ui';
import { useMessage } from 'naive-ui';
import AppIcon from './AppIcon.vue';
import { broadcast as apiBroadcast } from '../api';

const props = defineProps({ show: { type: Boolean, default: false } });
const emit = defineEmits(['update:show']);
const message = useMessage();
const text = ref('');
const sending = ref(false);

function close() {
  emit('update:show', false);
}

function send() {
  const content = text.value.trim();
  if (!content) {
    message.error('请输入消息内容');
    return;
  }
  sending.value = true;
  apiBroadcast(content)
    .then((d) => {
      message.success(`广播已发送给 ${d.count} 个节点`);
      text.value = '';
      close();
    })
    .catch((err) => message.error('广播失败: ' + err.message))
    .finally(() => {
      sending.value = false;
    });
}
</script>

<template>
  <NModal
    :show="props.show"
    :on-update:show="(v) => !v && close()"
    preset="card"
    :style="{ width: '480px', maxWidth: '92vw' }"
    title=""
  >
    <div class="np-bcast-head">
      <AppIcon name="message" :size="18" />
      <span>广播消息</span>
    </div>
    <p class="np-bcast-sub">向所有在线客户端节点发送一条通知（节点会写入自己的运行日志）。</p>
    <NInput
      v-model:value="text"
      type="textarea"
      placeholder="输入要广播的消息..."
      :rows="4"
      :disabled="sending"
    />
    <div class="np-bcast-actions">
      <NButton size="small" @click="close">取消</NButton>
      <NButton size="small" type="primary" :loading="sending" @click="send">发送广播</NButton>
    </div>
  </NModal>
</template>

<style scoped>
.np-bcast-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 10px;
}
.np-bcast-sub {
  color: var(--np-text-muted);
  font-size: 12.5px;
  margin: 0 0 12px;
}
.np-bcast-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
