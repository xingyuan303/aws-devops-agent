import * as fc from 'fast-check';

describe('Property Test Setup', () => {
  it('should have fast-check working', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        return typeof n === 'number';
      })
    );
  });
});
