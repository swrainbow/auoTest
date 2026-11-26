import { taskConfigExactRowSelector, type Workflow } from '../planner/workflow';

type Check = Workflow[number]['checks'][number];

function exactNameCount(check: Check | undefined, selector: string): number | undefined {
  if (check?.type === 'count' && 'locator' in check && check.locator.kind === 'css' && check.locator.value === selector) {
    return check.value;
  }
}

export function taskConfigGuardAtStep(workflow: Workflow, zeroBasedStepIndex: number, checkIndex: number): { name: string } | undefined {
  const step = workflow[zeroBasedStepIndex];
  const filter = step?.operations.at(-1);
  if (filter?.type === 'filter-task-config' &&
      exactNameCount(step.checks[checkIndex], taskConfigExactRowSelector(filter.value)) === 0) {
    return { name: filter.value };
  }
}

export function taskConfigCreationGuard(workflow: Workflow): { step: number; name: string } | undefined {
  for (const [stepIndex, step] of workflow.entries()) {
    for (const checkIndex of step.checks.keys()) {
      const guard = taskConfigGuardAtStep(workflow, stepIndex, checkIndex);
      if (!guard) continue;

      const selector = taskConfigExactRowSelector(guard.name);
      let lastCount = 0;
      for (const later of workflow.slice(stepIndex + 1)) {
        for (const check of later.checks) lastCount = exactNameCount(check, selector) ?? lastCount;
      }
      if (lastCount > 0) return { step: stepIndex + 1, name: guard.name };
    }
  }
}

export function simulationCreationGuard(workflow: Workflow): { kind: 'simulation-instance'; name: string } | undefined {
  const maps = new Set<string>();
  for (const { operations } of workflow) {
    for (const op of operations) {
      if (op.type === 'create-simulation-instance') maps.add(op.mapName);
    }
  }
  if (maps.size) return { kind: 'simulation-instance', name: [...maps].join('、') };
}

