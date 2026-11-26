/// <reference lib="dom" />

// This function is embedded in generated scripts and runs in the target page.
// Keep its dependencies local so published scripts retain their original behavior.
export async function readHookGraph(input: {
  node: string; stage: string; hook: string; compare: boolean; expected: string | null;
}): Promise<string> {
  const title = input.node + ' - ' + input.stage;
  function snapshot(): string {
    const drawers = Array.from(document.querySelectorAll('.el-drawer')).filter(drawer =>
      drawer.getClientRects().length > 0 && getComputedStyle(drawer).visibility !== 'hidden' &&
      drawer.querySelector('.el-drawer__title')?.textContent?.trim() === title);
    if (drawers.length !== 1) throw new Error('未找到唯一的阶段抽屉 ' + title);
    const graphs = drawers[0]!.querySelectorAll('.hook-chain .vue-flow');
    if (graphs.length !== 1) throw new Error(title + ' 缺少唯一的 Hook 执行顺序图');
    const graph = graphs[0]!;
    const cards = new Map<string, string>();
    for (const section of Array.from(drawers[0]!.querySelectorAll('.tk-form-switcher-section'))) {
      const heading = section.querySelector('.tk-form-dynamic-title')?.textContent?.trim() ?? '';
      const match = /^(\S+)\s+-\s+(.+)$/.exec(heading);
      if (!match || cards.has(match[1]!)) throw new Error('无法区分 Hook 卡片 ' + heading);
      cards.set(match[1]!, match[2]!);
    }
    if (Array.from(cards.values()).filter(type => type === input.hook).length !== 1) {
      throw new Error(title + ' 中需要恰好一个' + input.hook + ' Hook');
    }
    const labels = new Map<string, string>();
    const seen = new Set<string>();
    for (const node of Array.from(graph.querySelectorAll('.vue-flow__node'))) {
      const id = node.getAttribute('data-id');
      const label = node.textContent?.trim();
      if (!id || !label || labels.has(id) || seen.has(label) || !cards.has(label)) {
        throw new Error('执行图中的节点与 Hook 卡片不能一一对应');
      }
      labels.set(id, label);
      seen.add(label);
    }
    if (seen.size !== cards.size) throw new Error('执行图缺少 Hook 卡片对应的节点');
    const edges: string[] = [];
    for (const edge of Array.from(graph.querySelectorAll('.vue-flow__edge'))) {
      const path = edge.querySelector('.vue-flow__edge-path');
      const source = labels.get(path?.getAttribute('source') ?? '');
      const target = labels.get(path?.getAttribute('target') ?? '');
      if (!source || !target) throw new Error('执行图中的依赖连线没有对应的 Hook 节点');
      edges.push(JSON.stringify([source, target]));
    }
    const hooks = Array.from(cards, entry => JSON.stringify(entry)).sort();
    return JSON.stringify({ hooks, edges: edges.sort() });
  }
  if (input.compare && input.expected === null) throw new Error('缺少保存前的 Hook 执行图');
  // Vue Flow lays out nodes and renders the SVG edges over successive updates.
  let previous: string | undefined;
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      const current = snapshot();
      if (input.compare && input.expected !== current) throw new Error('回读的 Hook 节点或依赖关系与保存前不同');
      if (previous === current) return current;
      previous = current;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      previous = undefined;
    }
    if (Date.now() >= deadline) throw new Error('Hook 执行图未稳定');
    await new Promise(resolve => setTimeout(resolve, 80));
  }
}
