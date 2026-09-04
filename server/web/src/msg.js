// Shared naive-ui message instance - populated by MessageBridge (which lives
// INSIDE <n-message-provider>), usable from App-level code that sits outside it.
import { ref } from 'vue';

export const messageRef = ref(null);
