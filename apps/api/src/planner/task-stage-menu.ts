/// <reference lib="dom" />

// Embedded in generated scripts and evaluated inside the task editor.
export function findTaskStageMenu(input: { node: string; stage: string }): string {
  const headers = Array.from(document.querySelectorAll('.vue-flow__node-llm .node-header')).filter(header =>
    header.getClientRects().length && Array.from(header.children).some(child =>
      child.tagName === 'DIV' && child.textContent?.trim() === input.node));
  if (headers.length !== 1) throw new Error('无法确定唯一的任务主节点「' + input.node + '」');

  const matches = [];
  for (const trigger of Array.from(headers[0].querySelectorAll('[role="button"][aria-haspopup="menu"][aria-controls]'))) {
    const menu = document.getElementById(trigger.getAttribute('aria-controls')!);
    if (menu?.getAttribute('role') !== 'menu') continue;
    const choices = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    if (choices.some(item => item.textContent?.trim() === input.stage)) matches.push(menu.id);
  }
  if (matches.length !== 1) throw new Error('主节点「' + input.node + '」下找不到唯一包含「' + input.stage + '」的菜单');
  return matches[0];
}
