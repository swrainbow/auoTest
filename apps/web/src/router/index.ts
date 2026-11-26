import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    {
      path: '/dashboard',
      component: () => import('@/pages/DashboardPage.vue'),
      meta: { title: '总览', group: '概览' },
    },
    {
      path: '/preparations',
      component: () => import('@/pages/preparations/PreparationsPage.vue'),
      meta: { title: '测试准备', group: '执行' },
    },
    {
      path: '/runs',
      component: () => import('@/pages/runs/RunsPage.vue'),
      meta: { title: '测试运行', group: '执行' },
    },
    {
      path: '/runs/:id',
      component: () => import('@/pages/runs/RunDetailPage.vue'),
      meta: { title: '执行详情', group: '执行' },
    },
    {
      path: '/runs/:id/report',
      name: 'run-report',
      component: () => import('@/pages/runs/RunReportPage.vue'),
      meta: { title: '测试报告', group: '执行' },
    },
    {
      path: '/cases',
      component: () => import('@/pages/cases/CasesPage.vue'),
      meta: { title: '测试用例', group: '用例' },
    },
    {
      path: '/cases/new',
      component: () => import('@/pages/cases/CaseCreatePage.vue'),
      meta: { title: 'AI 创建', group: '用例' },
    },
    {
      path: '/cases/:id/edit',
      component: () => import('@/pages/cases/CaseEditPage.vue'),
      meta: { title: '用例编辑', group: '用例' },
    },
    {
      path: '/skills',
      component: () => import('@/pages/skills/SkillsPage.vue'),
      meta: { title: 'Skill 管理', group: '知识' },
    },
    {
      path: '/settings',
      component: () => import('@/pages/SettingsPage.vue'),
      meta: { title: '设置', group: '通用' },
    },
  ],
});

export default router;
