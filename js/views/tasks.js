/* ============================================================================
   views/tasks.js — the board and list across every project.

   The behaviour lives in js/taskui.js, because a project's own Tasks tab
   renders the same thing scoped to one project and two copies of the
   drag-and-drop, the column filters and the Jira selection would not have
   stayed in step. This file is the view wrapper: the route, the header
   actions, and the deep link.
   ========================================================================= */

import * as S from '../store.js';
import { taskPanel, editTask } from '../taskui.js';

import { queuedTasks } from '../jira.js';

export { editTask };

const UI_KEY = 'gfxprod.ui.tasks';

export default {
  id: 'tasks', title: 'Tasks', icon: 'board', group: 'work',
  subtitle: 'Everything in flight, across every project',

  actions: ctx => [
    { label: 'New task', icon: 'plus', primary: true,
      run: () => editTask(null).then(r => r && ctx.rerender()) },
    /* The queue lives on the Jira Imports screen now, not in a dialog, so this
       goes there rather than opening a window over the board. */
    { label: (() => { const n = queuedTasks().length; return n ? `Jira (${n})` : 'Jira'; })(),
      icon: 'link', run: () => ctx.go('jira-imports') },
  ],

  render(host, ctx) {
    taskPanel(host, ctx, { key: UI_KEY });

    // deep link: #/tasks/<id> or #/tasks/new
    const [p0] = ctx.params;
    if (p0 === 'new') {
      history.replaceState(null, '', '#/tasks');
      editTask(null).then(r => r && ctx.rerender());
    } else if (p0 && S.byId(S.get().tasks, p0)) {
      history.replaceState(null, '', '#/tasks');
      editTask(p0).then(r => r && ctx.rerender());
    }
  },
};
