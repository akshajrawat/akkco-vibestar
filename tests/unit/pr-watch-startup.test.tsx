// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { usePRWatch } from "../../src/features/pull-requests/usePRWatch";

afterEach(cleanup);

it("starts one authorized quick check after capability negotiation, without repeats on rerender", async () => {
  const rpc = vi.fn().mockResolvedValue(null);
  window.vibestar = { rpc } as unknown as typeof window.vibestar;

  const Watch = ({ enabled }: { enabled: boolean }) => {
    usePRWatch(enabled);
    return null;
  };

  const view = render(
    <StrictMode>
      <Watch enabled={false} />
    </StrictMode>,
  );

  expect(rpc).not.toHaveBeenCalled();

  view.rerender(
    <StrictMode>
      <Watch enabled />
    </StrictMode>,
  );

  await waitFor(() => expect(rpc).toHaveBeenCalledOnce());

  expect(rpc).toHaveBeenCalledWith("pr.watch.start", {
    request_id: expect.any(String),
    trigger: "open",
  });

  view.rerender(
    <StrictMode>
      <Watch enabled />
    </StrictMode>,
  );

  expect(rpc).toHaveBeenCalledOnce();
});
