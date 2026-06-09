/**
 * Unit tests for the Step Functions workflow definition.
 *
 * These tests build a fresh CDK Stack with stand-in Lambda functions, ask
 * `buildWorkflowDefinition` to wire up the state machine, and then synth the
 * stack so we can inspect the generated CloudFormation template. The
 * `DefinitionString` of the state machine is reconstructed back into a JSON
 * object so we can assert on:
 *   - State machine structure (StartAt, full set of states, terminal states)
 *   - Lambda task wiring (each Lambda is invoked from the right state)
 *   - Choice / Wait branch logic (filtered, grouping wait, RCA status,
 *     notification result)
 *   - Error handling / retries (Lambda service-exception retries on every Task)
 *   - Path scenarios from tasks.md task 11.3:
 *       * Normal flow path
 *       * Filter / reject path
 *       * Timeout (RCA Task TimeoutSeconds, overall workflow timeout)
 *       * Retry exhaustion (terminal RecordFailure path after notification fails)
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import {
  buildWorkflowDefinition,
  WorkflowLambdas,
  isValidWorkflowTransition,
  isValidWorkflowTransitionSequence,
  ALL_WORKFLOW_STATUSES,
  VALID_WORKFLOW_TRANSITIONS,
  WORKFLOW_INITIAL_STATE,
} from '../../src/shared/workflow-definition';

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

interface TestHarness {
  template: Template;
  definition: any;
  lambdaLogicalIds: {
    alarmRouter: string;
    alarmGrouper: string;
    rcaAnalyzer: string;
    feishuNotifier: string;
  };
}

function buildTestStack(): TestHarness {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'WorkflowTestStack');

  const makeFn = (id: string) =>
    new lambda.Function(stack, id, {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
    });

  const lambdas: WorkflowLambdas = {
    alarmRouter: makeFn('AlarmRouterFn'),
    alarmGrouper: makeFn('AlarmGrouperFn'),
    rcaAnalyzer: makeFn('RcaAnalyzerFn'),
    feishuNotifier: makeFn('FeishuNotifierFn'),
  };

  buildWorkflowDefinition(stack, lambdas);

  const template = Template.fromStack(stack);
  const definition = extractStateMachineDefinition(template);

  // Pull the CFN-generated logical IDs for each Lambda so tests can assert
  // that the right Lambda is invoked from each task.
  const lambdaLogicalIds = {
    alarmRouter: stack.resolve((lambdas.alarmRouter as lambda.Function).functionArn)['Fn::GetAtt'][0] as string,
    alarmGrouper: stack.resolve((lambdas.alarmGrouper as lambda.Function).functionArn)['Fn::GetAtt'][0] as string,
    rcaAnalyzer: stack.resolve((lambdas.rcaAnalyzer as lambda.Function).functionArn)['Fn::GetAtt'][0] as string,
    feishuNotifier: stack.resolve((lambdas.feishuNotifier as lambda.Function).functionArn)['Fn::GetAtt'][0] as string,
  };

  return { template, definition, lambdaLogicalIds };
}

/**
 * Extract the state machine definition as a JSON object by stitching together
 * the Fn::Join parts in the synthesized DefinitionString. CloudFormation
 * tokens (Ref / Fn::GetAtt objects) are replaced with deterministic
 * placeholders so the result is valid JSON.
 *
 * Each placeholder is shaped so we can later look it up by logical ID:
 *   - Ref objects become "<<REF:logicalId>>"
 *   - Fn::GetAtt objects become "<<GETATT:logicalId.attribute>>"
 */
function extractStateMachineDefinition(template: Template): any {
  const stateMachines = template.findResources('AWS::StepFunctions::StateMachine');
  const keys = Object.keys(stateMachines);
  expect(keys).toHaveLength(1);
  const stateMachine = stateMachines[keys[0]];

  const definitionString = stateMachine.Properties.DefinitionString;
  expect(definitionString).toBeDefined();
  expect(definitionString['Fn::Join']).toBeDefined();

  const parts = definitionString['Fn::Join'][1] as Array<string | object>;
  const joined = parts
    .map((part) => {
      if (typeof part === 'string') return part;
      const obj = part as Record<string, any>;
      if ('Ref' in obj) return `<<REF:${obj.Ref}>>`;
      if ('Fn::GetAtt' in obj) {
        const [logicalId, attr] = obj['Fn::GetAtt'];
        return `<<GETATT:${logicalId}.${attr}>>`;
      }
      // Fallback for unexpected token shapes
      return `<<TOKEN:${JSON.stringify(obj)}>>`;
    })
    .join('');

  return JSON.parse(joined);
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('buildWorkflowDefinition - state machine structure', () => {
  let harness: TestHarness;

  beforeAll(() => {
    harness = buildTestStack();
  });

  it('creates exactly one Standard state machine with tracing and a 15-minute timeout', () => {
    harness.template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    harness.template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'STANDARD',
      TracingConfiguration: { Enabled: true },
    });

    expect(harness.definition.TimeoutSeconds).toBe(900);
    expect(typeof harness.definition.Comment).toBe('string');
    expect(harness.definition.Comment).toMatch(/CloudWatch Alarm Auto RCA/i);
  });

  it('uses InvokeAlarmRouter as the entry state', () => {
    expect(harness.definition.StartAt).toBe('InvokeAlarmRouter');
  });

  it('contains every state required by the design (mermaid diagram)', () => {
    const expectedStates = [
      // Tasks
      'InvokeAlarmRouter',
      'InvokeAlarmGrouper',
      'InvokeRCAAnalyzer',
      'InvokeFeishuNotifierComplete',
      'InvokeFeishuNotifierPartial',
      // Choices
      'CheckFiltered',
      'CheckIsNewGroup',
      'CheckRCAStatus',
      'CheckNotificationResult',
      // Terminal Pass states
      'RecordSuppressed',
      'RecordFiltered',
      'RecordSuccess',
      'RecordPartial',
      'RecordFailure',
    ];

    for (const name of expectedStates) {
      expect(harness.definition.States[name]).toBeDefined();
    }
  });

  it('marks RecordFiltered, RecordSuccess, RecordPartial, RecordFailure as terminal Pass states', () => {
    for (const name of ['RecordFiltered', 'RecordSuccess', 'RecordPartial', 'RecordFailure', 'RecordSuppressed']) {
      const state = harness.definition.States[name];
      expect(state.Type).toBe('Pass');
      expect(state.End).toBe(true);
      expect(state.ResultPath).toBe('$.workflowResult');
      expect(state.Result).toEqual(expect.objectContaining({ outcome: expect.any(String) }));
    }

    expect(harness.definition.States.RecordFiltered.Result.outcome).toBe('filtered');
    expect(harness.definition.States.RecordSuccess.Result.outcome).toBe('success');
    expect(harness.definition.States.RecordPartial.Result.outcome).toBe('partial');
    expect(harness.definition.States.RecordFailure.Result.outcome).toBe('failure');
    expect(harness.definition.States.RecordSuppressed.Result.outcome).toBe('suppressed_duplicate');
  });
});

describe('buildWorkflowDefinition - Lambda task wiring', () => {
  let harness: TestHarness;

  beforeAll(() => {
    harness = buildTestStack();
  });

  /**
   * Helper: assert that a Task state invokes the given Lambda by checking
   * its Parameters.FunctionName against the GETATT placeholder we generated.
   */
  function expectInvokesLambda(stateName: string, logicalId: string) {
    const state = harness.definition.States[stateName];
    expect(state).toBeDefined();
    expect(state.Type).toBe('Task');
    expect(state.Resource).toContain('lambda:invoke');
    expect(state.Parameters.FunctionName).toBe(`<<GETATT:${logicalId}.Arn>>`);
  }

  it('InvokeAlarmRouter calls the alarm-router Lambda and forwards the entire payload', () => {
    expectInvokesLambda('InvokeAlarmRouter', harness.lambdaLogicalIds.alarmRouter);
    const state = harness.definition.States.InvokeAlarmRouter;
    expect(state.Parameters['Payload.$']).toBe('$');
    expect(state.OutputPath).toBe('$.Payload');
    expect(state.Next).toBe('CheckFiltered');
  });

  it('InvokeAlarmGrouper calls the alarm-grouper Lambda wrapping the input as { alarm }', () => {
    expectInvokesLambda('InvokeAlarmGrouper', harness.lambdaLogicalIds.alarmGrouper);
    const state = harness.definition.States.InvokeAlarmGrouper;
    expect(state.Parameters.Payload).toEqual({ 'alarm.$': '$' });
    expect(state.OutputPath).toBe('$.Payload');
    expect(state.Next).toBe('CheckIsNewGroup');
  });

  it('InvokeRCAAnalyzer calls the rca-analyzer Lambda using waitForTaskToken with groupId/alarms/taskToken and a 13-minute task timeout', () => {
    expectInvokesLambda('InvokeRCAAnalyzer', harness.lambdaLogicalIds.rcaAnalyzer);
    const state = harness.definition.States.InvokeRCAAnalyzer;
    // waitForTaskToken pattern uses the lambda:invoke.waitForTaskToken resource ARN
    expect(state.Resource).toContain('lambda:invoke');
    expect(state.Resource).toContain('waitForTaskToken');
    expect(state.Parameters.Payload).toEqual({
      'groupId.$': '$.groupId',
      'alarms.$': '$.alarms',
      'taskToken.$': '$$.Task.Token',
    });
    // 13 minutes => 780 seconds
    expect(state.TimeoutSeconds).toBe(780);
    // waitForTaskToken delivers SendTaskSuccess output as the step output directly,
    // so OutputPath must NOT be set.
    expect(state.OutputPath).toBeUndefined();
    expect(state.Next).toBe('CheckRCAStatus');
  });

  it('InvokeFeishuNotifierComplete sends an rca_complete payload to the feishu Lambda', () => {
    expectInvokesLambda('InvokeFeishuNotifierComplete', harness.lambdaLogicalIds.feishuNotifier);
    const state = harness.definition.States.InvokeFeishuNotifierComplete;
    expect(state.Parameters.Payload).toEqual({
      'rcaReport.$': '$.rcaReport',
      webhookUrls: [],
      notificationType: 'rca_complete',
    });
    expect(state.Next).toBe('CheckNotificationResult');
  });

  it('InvokeFeishuNotifierPartial sends an rca_partial payload to the feishu Lambda', () => {
    expectInvokesLambda('InvokeFeishuNotifierPartial', harness.lambdaLogicalIds.feishuNotifier);
    const state = harness.definition.States.InvokeFeishuNotifierPartial;
    expect(state.Parameters.Payload).toEqual({
      'rcaReport.$': '$.rcaReport',
      webhookUrls: [],
      notificationType: 'rca_partial',
    });
    expect(state.Next).toBe('RecordPartial');
  });
});

describe('buildWorkflowDefinition - Choice and Wait branching', () => {
  let harness: TestHarness;

  beforeAll(() => {
    harness = buildTestStack();
  });

  it('CheckFiltered routes filtered alarms to RecordFiltered and otherwise to InvokeAlarmGrouper', () => {
    const choice = harness.definition.States.CheckFiltered;
    expect(choice.Type).toBe('Choice');
    expect(choice.Default).toBe('InvokeAlarmGrouper');
    expect(choice.Choices).toContainEqual({
      Variable: '$.filtered',
      BooleanEquals: true,
      Next: 'RecordFiltered',
    });
  });

  it('CheckIsNewGroup routes isNewGroup=true to InvokeRCAAnalyzer, otherwise to RecordSuppressed', () => {
    const choice = harness.definition.States.CheckIsNewGroup;
    expect(choice.Type).toBe('Choice');
    expect(choice.Default).toBe('RecordSuppressed');
    expect(choice.Choices).toContainEqual({
      Variable: '$.isNewGroup',
      BooleanEquals: true,
      Next: 'InvokeRCAAnalyzer',
    });
  });

  it('RecordSuppressed is a terminal Pass marking the duplicate outcome', () => {
    const state = harness.definition.States.RecordSuppressed;
    expect(state.Type).toBe('Pass');
    expect(state.End).toBe(true);
    expect(state.Result.outcome).toBe('suppressed_duplicate');
  });

  it('CheckRCAStatus routes "completed" to InvokeFeishuNotifierComplete and any other status to InvokeFeishuNotifierPartial', () => {
    const choice = harness.definition.States.CheckRCAStatus;
    expect(choice.Type).toBe('Choice');
    expect(choice.Default).toBe('InvokeFeishuNotifierPartial');
    expect(choice.Choices).toContainEqual({
      Variable: '$.status',
      StringEquals: 'completed',
      Next: 'InvokeFeishuNotifierComplete',
    });
  });

  it('CheckNotificationResult routes success=true to RecordSuccess and otherwise to RecordFailure', () => {
    const choice = harness.definition.States.CheckNotificationResult;
    expect(choice.Type).toBe('Choice');
    expect(choice.Default).toBe('RecordFailure');
    expect(choice.Choices).toContainEqual({
      Variable: '$.success',
      BooleanEquals: true,
      Next: 'RecordSuccess',
    });
  });
});

describe('buildWorkflowDefinition - error handling and retries', () => {
  let harness: TestHarness;

  beforeAll(() => {
    harness = buildTestStack();
  });

  const taskStates = [
    'InvokeAlarmRouter',
    'InvokeAlarmGrouper',
    'InvokeRCAAnalyzer',
    'InvokeFeishuNotifierComplete',
    'InvokeFeishuNotifierPartial',
  ];

  // Errors injected by `retryOnServiceExceptions: true` on a LambdaInvoke task.
  const expectedRetryErrors = [
    'Lambda.ClientExecutionTimeoutException',
    'Lambda.ServiceException',
    'Lambda.AWSLambdaException',
    'Lambda.SdkClientException',
  ];

  it.each(taskStates)('Task %s declares Lambda service-exception retries', (stateName) => {
    const state = harness.definition.States[stateName];
    expect(state.Type).toBe('Task');
    expect(state.Retry).toBeDefined();
    expect(Array.isArray(state.Retry)).toBe(true);
    expect(state.Retry.length).toBeGreaterThanOrEqual(1);

    const retryEntry = state.Retry[0];
    for (const err of expectedRetryErrors) {
      expect(retryEntry.ErrorEquals).toContain(err);
    }
    // CDK defaults: IntervalSeconds=2, MaxAttempts=6, BackoffRate=2
    expect(retryEntry.MaxAttempts).toBeGreaterThan(0);
    expect(retryEntry.IntervalSeconds).toBeGreaterThan(0);
    expect(retryEntry.BackoffRate).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// End-to-end path scenarios from tasks.md task 11.3
// -----------------------------------------------------------------------------

describe('buildWorkflowDefinition - workflow path scenarios', () => {
  let harness: TestHarness;

  beforeAll(() => {
    harness = buildTestStack();
  });

  /**
   * Walk the static state graph from `start` choosing a deterministic next
   * state at every Choice node based on `choicePicker(stateName)` and stop
   * at any End / terminal state.
   */
  function tracePath(start: string, choicePicker: (stateName: string) => string): string[] {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = start;

    while (current) {
      if (seen.has(current)) throw new Error(`Cycle detected at ${current}`);
      seen.add(current);
      path.push(current);

      const state: any = harness.definition.States[current];
      if (!state) throw new Error(`Unknown state: ${current}`);
      if (state.End === true) break;
      if (state.Type === 'Choice') {
        current = choicePicker(current);
        continue;
      }
      current = state.Next as string | undefined;
    }

    return path;
  }

  it('normal flow path: alarm passes filter, no grouping, RCA completes, notification succeeds', () => {
    const path = tracePath('InvokeAlarmRouter', (stateName) => {
      switch (stateName) {
        case 'CheckFiltered':
          return 'InvokeAlarmGrouper'; // not filtered
        case 'CheckIsNewGroup':
          return 'InvokeRCAAnalyzer'; // owner runs RCA immediately
        case 'CheckRCAStatus':
          return 'InvokeFeishuNotifierComplete'; // completed
        case 'CheckNotificationResult':
          return 'RecordSuccess'; // notification succeeded
        default:
          throw new Error(`Unhandled choice: ${stateName}`);
      }
    });

    expect(path).toEqual([
      'InvokeAlarmRouter',
      'CheckFiltered',
      'InvokeAlarmGrouper',
      'CheckIsNewGroup',
      'InvokeRCAAnalyzer',
      'CheckRCAStatus',
      'InvokeFeishuNotifierComplete',
      'CheckNotificationResult',
      'RecordSuccess',
    ]);
  });

  it('dedup path: isNewGroup=false (joined active group) terminates at RecordSuppressed without invoking the RCA analyzer', () => {
    const path = tracePath('InvokeAlarmGrouper', (stateName) => {
      switch (stateName) {
        case 'CheckIsNewGroup':
          return 'RecordSuppressed';
        default:
          throw new Error(`Unhandled choice: ${stateName}`);
      }
    });

    expect(path).toEqual(['InvokeAlarmGrouper', 'CheckIsNewGroup', 'RecordSuppressed']);
    expect(path).not.toContain('InvokeRCAAnalyzer');
  });

  it('filter / reject path: filtered alarms terminate at RecordFiltered without invoking grouper or analyzer', () => {
    const path = tracePath('InvokeAlarmRouter', (stateName) => {
      if (stateName === 'CheckFiltered') return 'RecordFiltered';
      throw new Error(`Unexpected choice on filter path: ${stateName}`);
    });

    expect(path).toEqual(['InvokeAlarmRouter', 'CheckFiltered', 'RecordFiltered']);
    expect(path).not.toContain('InvokeAlarmGrouper');
    expect(path).not.toContain('InvokeRCAAnalyzer');
    expect(path).not.toContain('InvokeFeishuNotifierComplete');
  });

  it('timeout / partial path: non-completed RCA status routes to InvokeFeishuNotifierPartial and then RecordPartial', () => {
    const path = tracePath('InvokeRCAAnalyzer', (stateName) => {
      if (stateName === 'CheckRCAStatus') return 'InvokeFeishuNotifierPartial';
      throw new Error(`Unexpected choice on timeout path: ${stateName}`);
    });

    expect(path).toEqual([
      'InvokeRCAAnalyzer',
      'CheckRCAStatus',
      'InvokeFeishuNotifierPartial',
      'RecordPartial',
    ]);
    // Partial path must NOT touch the success-only branch
    expect(path).not.toContain('InvokeFeishuNotifierComplete');
    expect(path).not.toContain('CheckNotificationResult');
    expect(path).not.toContain('RecordSuccess');
  });

  it('retry-exhausted path: a failed notification (success=false) lands at RecordFailure', () => {
    const path = tracePath('InvokeFeishuNotifierComplete', (stateName) => {
      if (stateName === 'CheckNotificationResult') return 'RecordFailure';
      throw new Error(`Unexpected choice on retry-exhausted path: ${stateName}`);
    });

    expect(path).toEqual([
      'InvokeFeishuNotifierComplete',
      'CheckNotificationResult',
      'RecordFailure',
    ]);
  });
});

// -----------------------------------------------------------------------------
// Pure helper exports (state-transition logic) — sanity coverage. The full
// property-test coverage lives in test/property/workflow-transitions.test.ts.
// -----------------------------------------------------------------------------

describe('workflow status transition helpers', () => {
  it('exposes the canonical initial state', () => {
    expect(WORKFLOW_INITIAL_STATE).toBe('pending');
  });

  it('lists every status used by VALID_WORKFLOW_TRANSITIONS', () => {
    const tableKeys = Object.keys(VALID_WORKFLOW_TRANSITIONS).sort();
    const allStatuses = [...ALL_WORKFLOW_STATUSES].sort();
    expect(tableKeys).toEqual(allStatuses);
  });

  it('accepts each documented happy-path transition', () => {
    expect(isValidWorkflowTransition('pending', 'analyzing')).toBe(true);
    expect(isValidWorkflowTransition('analyzing', 'completed')).toBe(true);
    expect(isValidWorkflowTransition('analyzing', 'failed')).toBe(true);
    expect(isValidWorkflowTransition('analyzing', 'timed_out')).toBe(true);
    expect(isValidWorkflowTransition('completed', 'notified')).toBe(true);
    expect(isValidWorkflowTransition('timed_out', 'notified')).toBe(true);
  });

  it('rejects illegal jumps that bypass intermediate states', () => {
    expect(isValidWorkflowTransition('pending', 'completed')).toBe(false);
    expect(isValidWorkflowTransition('pending', 'notified')).toBe(false);
    expect(isValidWorkflowTransition('completed', 'analyzing')).toBe(false);
    expect(isValidWorkflowTransition('failed', 'notified')).toBe(false);
    expect(isValidWorkflowTransition('notified', 'pending')).toBe(false);
  });

  it('validates the three canonical end-to-end sequences', () => {
    expect(
      isValidWorkflowTransitionSequence(['pending', 'analyzing', 'completed', 'notified'])
    ).toBe(true);
    expect(isValidWorkflowTransitionSequence(['pending', 'analyzing', 'failed'])).toBe(true);
    expect(
      isValidWorkflowTransitionSequence(['pending', 'analyzing', 'timed_out', 'notified'])
    ).toBe(true);
  });

  it('rejects sequences that do not start at pending', () => {
    expect(isValidWorkflowTransitionSequence(['analyzing', 'completed'])).toBe(false);
  });
});
