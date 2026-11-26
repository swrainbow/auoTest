import type { PreparationFlow, PreparationSelection } from '@autotest/shared';

export const selectionLabel: Record<PreparationSelection, string> = {
  unique: '自动确定唯一服务',
  explicit: '必须填写服务完整名称',
};

export function flowLabel(flow: PreparationFlow, flows: PreparationFlow[]): string {
  const label = `${flow.name} · 规则 v${flow.ruleVersion}`;
  const duplicate = flows.some(item => item.id !== flow.id && item.name === flow.name && item.ruleVersion === flow.ruleVersion);
  return duplicate ? `${label} · #${flow.id.slice(-8)}` : label;
}
