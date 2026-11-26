const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { findTaskStageMenu } = require('../src/planner/task-stage-menu');
const { compileWorkflow } = require('../src/planner/workflow');

test('stage selection follows the target header’s linked menu even when the action menu comes first', () => {
  const header = (name, menuIds) => ({
    children: [{ tagName: 'DIV', textContent: name }],
    getClientRects: () => [1],
    querySelectorAll: () => menuIds.map(id => ({ getAttribute: () => id })),
  });
  const menus = { actions: ['删除'], pickup: ['创建时', '离开后'], dropoff: ['创建时', '离开后'] };
  const document = {
    querySelectorAll: () => [header('取货', ['actions', 'pickup']), header('放货', ['dropoff'])],
    getElementById: id => ({
      id, getAttribute: () => 'menu',
      querySelectorAll: () => menus[id].map(textContent => ({ textContent })),
    }),
  };
  const input = { node: '取货', stage: '离开后' };
  const read = () => runInNewContext('(' + findTaskStageMenu.toString() + ')(input)', { document, input });
  assert.equal(read(), 'pickup');
  menus.actions.push('离开后');
  assert.throws(read, /唯一/);

  const script = compileWorkflow('新增阶段', [{ action: '配置取货' }], [{
    operations: [{ type: 'add-task-config-stage', ...input }], checks: [],
  }]);
  assert.ok(script.includes(findTaskStageMenu.toString()));
  assert.match(script, /\.press\("ArrowDown"\)[\s\S]*expect\(choice\)\.toBeVisible\(\)[\s\S]*choice\.press\("Enter"\)/);
});
