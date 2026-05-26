// Feature: cloudwatch-alarm-auto-rca, Property 5: Workflow state transition validity
// Validates: Requirements 2.2
//
// Tests the production state-transition logic exposed by
// `src/shared/workflow-definition.ts` against the contract:
//   pending → analyzing → completed → notified
//   pending → analyzing → failed
//   pending → analyzing → timed_out → notified

import * as fc from 'fast-check';
import {
  ALL_WORKFLOW_STATUSES,
  VALID_WORKFLOW_TRANSITIONS,
  WORKFLOW_INITIAL_STATE,
  WorkflowStatus,
  isValidWorkflowTransition,
  isValidWorkflowTransitionSequence,
} from '../../src/shared/workflow-definition';

// --- Arbitrary generators ---

const arbState: fc.Arbitrary<WorkflowStatus> = fc.constantFrom(...ALL_WORKFLOW_STATUSES);

// All valid prefixes of the three canonical paths, including intermediate truncations.
const arbValidSequence: fc.Arbitrary<WorkflowStatus[]> = fc.constantFrom<WorkflowStatus[]>(
  ['pending'],
  ['pending', 'analyzing'],
  ['pending', 'analyzing', 'completed'],
  ['pending', 'analyzing', 'completed', 'notified'],
  ['pending', 'analyzing', 'failed'],
  ['pending', 'analyzing', 'timed_out'],
  ['pending', 'analyzing', 'timed_out', 'notified']
);

// Generator for arbitrary (possibly invalid) transition sequences
const arbArbitrarySequence = fc.array(arbState, { minLength: 2, maxLength: 6 });

describe('Property 5: Workflow state transition validity', () => {
  it('all known canonical valid paths (and their prefixes) are accepted', () => {
    fc.assert(
      fc.property(arbValidSequence, (sequence) => {
        expect(isValidWorkflowTransitionSequence(sequence)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('each individual transition in a valid path is valid', () => {
    fc.assert(
      fc.property(arbValidSequence, (sequence) => {
        for (let i = 0; i < sequence.length - 1; i++) {
          expect(isValidWorkflowTransition(sequence[i], sequence[i + 1])).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('sequences not starting with the initial state are always invalid', () => {
    const nonInitialStates = ALL_WORKFLOW_STATUSES.filter((s) => s !== WORKFLOW_INITIAL_STATE);
    fc.assert(
      fc.property(
        fc.constantFrom<WorkflowStatus>(...nonInitialStates),
        fc.array(arbState, { minLength: 0, maxLength: 5 }),
        (firstState, rest) => {
          const sequence = [firstState, ...rest];
          expect(isValidWorkflowTransitionSequence(sequence)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('terminal states (failed, notified) cannot transition to any other state', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<WorkflowStatus>('failed', 'notified'),
        arbState,
        (terminalState, nextState) => {
          expect(isValidWorkflowTransition(terminalState, nextState)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('pending can only transition to analyzing', () => {
    fc.assert(
      fc.property(arbState, (nextState) => {
        const expected = nextState === 'analyzing';
        expect(isValidWorkflowTransition('pending', nextState)).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('analyzing can only transition to completed, failed, or timed_out', () => {
    const allowed: WorkflowStatus[] = ['completed', 'failed', 'timed_out'];
    fc.assert(
      fc.property(arbState, (nextState) => {
        const expected = allowed.includes(nextState);
        expect(isValidWorkflowTransition('analyzing', nextState)).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('completed can only transition to notified', () => {
    fc.assert(
      fc.property(arbState, (nextState) => {
        const expected = nextState === 'notified';
        expect(isValidWorkflowTransition('completed', nextState)).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('timed_out can only transition to notified', () => {
    fc.assert(
      fc.property(arbState, (nextState) => {
        const expected = nextState === 'notified';
        expect(isValidWorkflowTransition('timed_out', nextState)).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('arbitrary random sequences are correctly classified by reference computation', () => {
    fc.assert(
      fc.property(arbArbitrarySequence, (sequence) => {
        const result = isValidWorkflowTransitionSequence(sequence);

        // Reference: re-derive expected validity from the table directly.
        let expectedValid = sequence[0] === WORKFLOW_INITIAL_STATE;
        if (expectedValid) {
          for (let i = 0; i < sequence.length - 1; i++) {
            const allowed = VALID_WORKFLOW_TRANSITIONS[sequence[i]] ?? [];
            if (!allowed.includes(sequence[i + 1])) {
              expectedValid = false;
              break;
            }
          }
        }
        expect(result).toBe(expectedValid);
      }),
      { numRuns: 200 }
    );
  });

  it('any sequence ending in a terminal state cannot be extended with another state', () => {
    fc.assert(
      fc.property(arbValidSequence, arbState, (validSeq, extra) => {
        const last = validSeq[validSeq.length - 1];
        if (last !== 'failed' && last !== 'notified') return; // only check terminal-ended sequences
        const extended = [...validSeq, extra];
        expect(isValidWorkflowTransitionSequence(extended)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('the empty sequence is vacuously valid', () => {
    expect(isValidWorkflowTransitionSequence([])).toBe(true);
  });
});
