import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory('/app/'),
  routes: [
    {
      path: '/',
      name: 'workbench',
      component: () => import('./views/Workbench.vue'),
      meta: { title: '工作台' },
    },
    {
      path: '/nodes',
      name: 'nodes',
      component: () => import('./views/Nodes.vue'),
      meta: { title: '节点管理' },
    },
    {
      path: '/logs',
      name: 'logs',
      component: () => import('./views/Logs.vue'),
      meta: { title: '请求日志' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/Settings.vue'),
      meta: { title: '系统设置' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

export default router;
