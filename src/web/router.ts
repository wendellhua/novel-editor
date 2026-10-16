import { createRouter, createWebHistory } from 'vue-router';
import LibraryView from './views/LibraryView.vue';
import SettingsView from './views/SettingsView.vue';
import WorkspaceView from './views/WorkspaceView.vue';

declare module 'vue-router' {
  interface RouteMeta {
    /** 铺满内容区（无内边距），用于写作工作区。 */
    fullBleed?: boolean;
  }
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'library', component: LibraryView },
    { path: '/works/:workId/:chapterId?', name: 'workspace', component: WorkspaceView, meta: { fullBleed: true } },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
