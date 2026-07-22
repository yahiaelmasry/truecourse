import { beforeEach, describe, expect, it, vi } from 'vitest';

const socketDouble = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
}));
const emit = vi.hoisted(() => vi.fn());

vi.mock('../../apps/dashboard/server/src/socket/index.js', () => ({
  getIO: () => ({
    sockets: { sockets: new Map([['socket', socketDouble]]) },
    to: () => ({ emit }),
  }),
}));

import { createSocketStashConfirmHandler } from '../../apps/dashboard/server/src/socket/handlers.js';

describe('dashboard stash confirmation', () => {
  beforeEach(() => {
    socketDouble.on.mockReset();
    socketDouble.removeListener.mockReset();
    emit.mockReset();
  });

  it('resolves cancel and removes its listener when the run is aborted', async () => {
    const controller = new AbortController();
    const choice = createSocketStashConfirmHandler('repo-id', controller.signal)({
      modifiedCount: 2,
      untrackedCount: 1,
    });

    expect(socketDouble.on).toHaveBeenCalledWith(
      'analysis:stash-confirm-response',
      expect.any(Function),
    );
    controller.abort();

    await expect(choice).resolves.toBe('cancel');
    expect(socketDouble.removeListener).toHaveBeenCalledWith(
      'analysis:stash-confirm-response',
      expect.any(Function),
    );
  });
});
