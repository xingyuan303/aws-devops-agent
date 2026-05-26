import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Lambda functions required by the workflow.
 */
export interface WorkflowLambdas {
  alarmRouter: lambda.IFunction;
  alarmGrouper: lambda.IFunction;
  rcaAnalyzer: lambda.IFunction;
  feishuNotifier: lambda.IFunction;
}

// -----------------------------------------------------------------------------
// Workflow State Transition Logic
// -----------------------------------------------------------------------------

/**
 * Valid workflow execution status values, matching WorkflowExecution.status.
 *
 * See Requirements 2.2.
 */
export type WorkflowStatus =
  | 'pending'
  | 'analyzing'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'notified';

/**
 * The list of all valid workflow status values.
 */
export const ALL_WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  'pending',
  'analyzing',
  'completed',
  'failed',
  'timed_out',
  'notified',
] as const;

/**
 * The valid transitions for the CloudWatch Alarm Auto RCA workflow.
 *
 * Validates: Requirements 2.2
 *
 * Allowed paths:
 *   pending → analyzing → completed → notified
 *   pending → analyzing → failed
 *   pending → analyzing → timed_out → notified
 *
 * Terminal states (failed, notified) have no outgoing transitions.
 */
export const VALID_WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
  pending: ['analyzing'],
  analyzing: ['completed', 'failed', 'timed_out'],
  completed: ['notified'],
  failed: [],
  timed_out: ['notified'],
  notified: [],
};

/**
 * The required initial state for any workflow execution.
 */
export const WORKFLOW_INITIAL_STATE: WorkflowStatus = 'pending';

/**
 * Returns true iff `to` is a valid next state from `from`.
 *
 * @param from - The current workflow status
 * @param to - The proposed next workflow status
 */
export function isValidWorkflowTransition(
  from: WorkflowStatus,
  to: WorkflowStatus
): boolean {
  return VALID_WORKFLOW_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Validates an entire transition sequence beginning from the workflow initial state.
 *
 * The empty sequence is considered valid (vacuous truth).
 * A non-empty sequence must start with `WORKFLOW_INITIAL_STATE` ("pending"),
 * and every adjacent pair (s_i, s_{i+1}) must satisfy `isValidWorkflowTransition`.
 *
 * @param sequence - The ordered sequence of workflow states
 * @returns true iff the sequence is a valid path through the state machine
 */
export function isValidWorkflowTransitionSequence(
  sequence: readonly WorkflowStatus[]
): boolean {
  if (sequence.length === 0) return true;
  if (sequence[0] !== WORKFLOW_INITIAL_STATE) return false;

  for (let i = 0; i < sequence.length - 1; i++) {
    if (!isValidWorkflowTransition(sequence[i], sequence[i + 1])) {
      return false;
    }
  }
  return true;
}

/**
 * Builds the Step Functions state machine definition for the CloudWatch Alarm Auto RCA workflow.
 *
 * Workflow:
 *   [Start] → InvokeAlarmRouter → CheckFiltered?
 *     → Yes (filtered=true) → RecordFiltered → [End]
 *     → No → InvokeAlarmGrouper → CheckShouldWait?
 *       → Yes (shouldWait=true) → WaitForGroupWindow → InvokeRCAAnalyzer
 *       → No → InvokeRCAAnalyzer
 *   InvokeRCAAnalyzer → CheckRCAStatus?
 *     → "completed" → InvokeFeishuNotifier(rca_complete) → RecordSuccess → [End]
 *     → "partial"/"failed" → InvokeFeishuNotifier(rca_partial/rca_timeout) → RecordPartial → [End]
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */
export function buildWorkflowDefinition(
  scope: Construct,
  lambdas: WorkflowLambdas
): sfn.StateMachine {
  // --- Terminal states ---
  const recordFiltered = new sfn.Pass(scope, 'RecordFiltered', {
    result: sfn.Result.fromObject({ outcome: 'filtered' }),
    resultPath: '$.workflowResult',
  });

  const recordSuccess = new sfn.Pass(scope, 'RecordSuccess', {
    result: sfn.Result.fromObject({ outcome: 'success' }),
    resultPath: '$.workflowResult',
  });

  const recordPartial = new sfn.Pass(scope, 'RecordPartial', {
    result: sfn.Result.fromObject({ outcome: 'partial' }),
    resultPath: '$.workflowResult',
  });

  const recordFailure = new sfn.Pass(scope, 'RecordFailure', {
    result: sfn.Result.fromObject({ outcome: 'failure' }),
    resultPath: '$.workflowResult',
  });

  // --- Step 1: Invoke AlarmRouter ---
  const invokeAlarmRouter = new tasks.LambdaInvoke(scope, 'InvokeAlarmRouter', {
    lambdaFunction: lambdas.alarmRouter,
    outputPath: '$.Payload',
    retryOnServiceExceptions: true,
  });

  // --- Step 2: Check if alarm was filtered ---
  const checkFiltered = new sfn.Choice(scope, 'CheckFiltered');

  // --- Step 3: Invoke AlarmGrouper ---
  const invokeAlarmGrouper = new tasks.LambdaInvoke(scope, 'InvokeAlarmGrouper', {
    lambdaFunction: lambdas.alarmGrouper,
    payload: sfn.TaskInput.fromObject({
      alarm: sfn.JsonPath.entirePayload,
    }),
    outputPath: '$.Payload',
    retryOnServiceExceptions: true,
  });

  // --- Step 4: Check if should wait for grouping window ---
  const checkShouldWait = new sfn.Choice(scope, 'CheckShouldWait');

  // --- Step 5: Wait for grouping window ---
  const waitForGroupWindow = new sfn.Wait(scope, 'WaitForGroupWindow', {
    time: sfn.WaitTime.secondsPath('$.waitSeconds'),
  });

  // --- Prepare wait seconds (calculate from waitUntil) ---
  const prepareWaitSeconds = new sfn.Pass(scope, 'PrepareWaitSeconds', {
    parameters: {
      'groupId.$': '$.groupId',
      'alarms.$': '$.alarms',
      'isNewGroup.$': '$.isNewGroup',
      'shouldWait.$': '$.shouldWait',
      'waitUntil.$': '$.waitUntil',
      'waitSeconds': 120, // Default grouping window (2 minutes)
    },
  });

  // --- Step 6: Invoke RCAAnalyzer (waitForTaskToken pattern) ---
  //
  // 改为 .waitForTaskToken 模式：Lambda 收到的 input 会被 SFN 自动注入
  // taskToken 字段。Lambda 触发 DevOps Agent webhook 后立即返回；SFN 在
  // 这一步挂起，直到外部（InvestigationEventHandler Lambda）调用
  // SendTaskSuccess(taskToken, { rcaReport, status, duration }) 把
  // 调查结果回传，SFN 才会继续走 CheckRCAStatus 分支。
  //
  // taskTimeout 给到 13 分钟，让 DevOps Agent 有充足时间跑完调查
  // （状态机本身的 timeout 仍然是 15 分钟）。
  const invokeRCAAnalyzer = new tasks.LambdaInvoke(scope, 'InvokeRCAAnalyzer', {
    lambdaFunction: lambdas.rcaAnalyzer,
    integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    payload: sfn.TaskInput.fromObject({
      groupId: sfn.JsonPath.stringAt('$.groupId'),
      alarms: sfn.JsonPath.listAt('$.alarms'),
      taskToken: sfn.JsonPath.taskToken,
    }),
    // 注意：waitForTaskToken 模式下 SFN 把整个 SendTaskSuccess 的 output 作为这一步的输出，
    // 这里**不要**再设 outputPath。让 RCAAnalyzerOutput 原样进入下一个状态。
    retryOnServiceExceptions: true,
    taskTimeout: sfn.Timeout.duration(cdk.Duration.minutes(13)),
  });

  // --- Step 7: Check RCA status ---
  const checkRCAStatus = new sfn.Choice(scope, 'CheckRCAStatus');

  // --- Step 8a: Invoke FeishuNotifier for complete RCA ---
  const invokeFeishuNotifierComplete = new tasks.LambdaInvoke(
    scope,
    'InvokeFeishuNotifierComplete',
    {
      lambdaFunction: lambdas.feishuNotifier,
      payload: sfn.TaskInput.fromObject({
        rcaReport: sfn.JsonPath.objectAt('$.rcaReport'),
        webhookUrls: [],
        notificationType: 'rca_complete',
      }),
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    }
  );

  // --- Step 8b: Invoke FeishuNotifier for partial/timeout RCA ---
  const invokeFeishuNotifierPartial = new tasks.LambdaInvoke(
    scope,
    'InvokeFeishuNotifierPartial',
    {
      lambdaFunction: lambdas.feishuNotifier,
      payload: sfn.TaskInput.fromObject({
        rcaReport: sfn.JsonPath.objectAt('$.rcaReport'),
        webhookUrls: [],
        notificationType: 'rca_partial',
      }),
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    }
  );

  // --- Check notification result ---
  const checkNotificationResult = new sfn.Choice(scope, 'CheckNotificationResult');

  // --- Wire up the workflow ---

  // AlarmRouter → Check if filtered
  invokeAlarmRouter.next(checkFiltered);

  // If filtered → record and end
  checkFiltered
    .when(sfn.Condition.booleanEquals('$.filtered', true), recordFiltered)
    .otherwise(invokeAlarmGrouper);

  // AlarmGrouper → Check if should wait
  invokeAlarmGrouper.next(checkShouldWait);

  // If should wait → wait then analyze; otherwise analyze immediately
  checkShouldWait
    .when(
      sfn.Condition.booleanEquals('$.shouldWait', true),
      prepareWaitSeconds.next(waitForGroupWindow).next(invokeRCAAnalyzer)
    )
    .otherwise(invokeRCAAnalyzer);

  // RCAAnalyzer → Check status
  invokeRCAAnalyzer.next(checkRCAStatus);

  // If completed → send complete notification
  checkRCAStatus
    .when(
      sfn.Condition.stringEquals('$.status', 'completed'),
      invokeFeishuNotifierComplete
    )
    .otherwise(invokeFeishuNotifierPartial);

  // Complete notification → check result
  invokeFeishuNotifierComplete.next(checkNotificationResult);

  checkNotificationResult
    .when(sfn.Condition.booleanEquals('$.success', true), recordSuccess)
    .otherwise(recordFailure);

  // Partial notification → record partial
  invokeFeishuNotifierPartial.next(recordPartial);

  // --- Create the state machine ---
  const stateMachine = new sfn.StateMachine(scope, 'AlarmRCAWorkflow', {
    definitionBody: sfn.DefinitionBody.fromChainable(invokeAlarmRouter),
    stateMachineType: sfn.StateMachineType.STANDARD,
    timeout: cdk.Duration.minutes(15),
    tracingEnabled: true,
    comment: 'CloudWatch Alarm Auto RCA Workflow - Orchestrates alarm parsing, grouping, RCA analysis, and notification',
  });

  return stateMachine;
}
