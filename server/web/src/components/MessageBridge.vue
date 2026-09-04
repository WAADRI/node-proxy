<script setup>
// Bridges the naive-ui message instance out of <n-message-provider> so that
// layout-level code (App.vue header actions) can show toasts.
import { useMessage } from 'naive-ui';
import { messageRef } from '../msg';

const message = useMessage();
messageRef.value = message;
</script>

<template><span style="display: none"></span></template>
