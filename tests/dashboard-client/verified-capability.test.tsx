import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCapabilities = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ getCapabilities }));

import { AppProvider, useVerifiedCapability } from '@/contexts/CapabilityContext';

function Probe() {
  return <div>{useVerifiedCapability('local-filesystem') ? 'verified local' : 'not verified'}</div>;
}

describe('useVerifiedCapability', () => {
  beforeEach(() => {
    getCapabilities.mockReset();
  });

  it('does not expose community defaults while capability discovery is pending', () => {
    getCapabilities.mockReturnValue(new Promise(() => undefined));

    render(<AppProvider><Probe /></AppProvider>);

    expect(screen.getByText('not verified')).toBeInTheDocument();
  });

  it('exposes a capability after a successful verified snapshot', () => {
    render(
      <AppProvider initial={{ edition: 'community', capabilities: ['local-filesystem'] }}>
        <Probe />
      </AppProvider>,
    );

    expect(screen.getByText('verified local')).toBeInTheDocument();
  });

  it('does not authorize a restricted request when capability discovery fails', async () => {
    getCapabilities.mockRejectedValue(new Error('hosted capability service unavailable'));

    render(<AppProvider><Probe /></AppProvider>);

    await waitFor(() => expect(getCapabilities).toHaveBeenCalled());
    expect(screen.getByText('not verified')).toBeInTheDocument();
  });
});
