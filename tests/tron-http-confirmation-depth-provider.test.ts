import { describe, expect, it } from "vitest";

import {
  HttpTronConfirmationDepthProvider,
} from "../src/adapters/tron/tron-http-confirmation-depth-provider.js";
import type {
  TronHttpReadResult,
  TronLatestBlockHttpTransport,
} from "../src/adapters/tron/tron-http-transport.js";
import type { TronReadView } from "../src/core/payments/tron-read-source.js";

class FakeLatestBlockTransport
  implements TronLatestBlockHttpTransport
{
  readonly name = "fake-latest-block";
  readonly calls: Array<{ view: TronReadView }> = [];

  constructor(
    private readonly result: TronHttpReadResult,
  ) {}

  async getLatestBlock(input: {
    readonly view: TronReadView;
  }): Promise<TronHttpReadResult> {
    this.calls.push(input);
    return this.result;
  }
}

function block(number: number | string): TronHttpReadResult {
  return {
    kind: "ok",
    body: {
      block_header: {
        raw_data: {
          number,
        },
      },
    },
  };
}

describe("HttpTronConfirmationDepthProvider", () => {
  it("calculates inclusive head-view depth", async () => {
    const transport = new FakeLatestBlockTransport(
      block(70_000_004),
    );
    const provider = new HttpTronConfirmationDepthProvider(
      transport,
    );

    await expect(
      provider.getConfirmationDepth({
        view: "head",
        transactionBlockNumber: "70000000",
      }),
    ).resolves.toEqual({
      kind: "available",
      confirmations: 5,
    });

    expect(transport.calls).toEqual([{ view: "head" }]);
  });

  it("returns one confirmation when the transaction is at the latest visible height", async () => {
    const provider = new HttpTronConfirmationDepthProvider(
      new FakeLatestBlockTransport(block("70000000")),
    );

    await expect(
      provider.getConfirmationDepth({
        view: "solidified",
        transactionBlockNumber: "70000000",
      }),
    ).resolves.toEqual({
      kind: "available",
      confirmations: 1,
    });
  });

  it("preserves the requested solidified view", async () => {
    const transport = new FakeLatestBlockTransport(
      block(70_000_010),
    );
    const provider = new HttpTronConfirmationDepthProvider(
      transport,
    );

    await provider.getConfirmationDepth({
      view: "solidified",
      transactionBlockNumber: "70000000",
    });

    expect(transport.calls).toEqual([
      { view: "solidified" },
    ]);
  });

  it("propagates transport unavailability", async () => {
    const provider = new HttpTronConfirmationDepthProvider(
      new FakeLatestBlockTransport({
        kind: "unavailable",
        reason: "rate_limited",
      }),
    );

    await expect(
      provider.getConfirmationDepth({
        view: "solidified",
        transactionBlockNumber: "70000000",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "rate_limited",
    });
  });

  it("fails closed when latest-block data is absent or malformed", async () => {
    const cases: TronHttpReadResult[] = [
      { kind: "not_found" },
      { kind: "ok", body: {} },
      {
        kind: "ok",
        body: { block_header: {} },
      },
      {
        kind: "ok",
        body: {
          block_header: {
            raw_data: { number: -1 },
          },
        },
      },
      {
        kind: "ok",
        body: {
          block_header: {
            raw_data: {
              number: Number.MAX_SAFE_INTEGER + 1,
            },
          },
        },
      },
    ];

    for (const result of cases) {
      const provider = new HttpTronConfirmationDepthProvider(
        new FakeLatestBlockTransport(result),
      );

      await expect(
        provider.getConfirmationDepth({
          view: "solidified",
          transactionBlockNumber: "70000000",
        }),
      ).resolves.toEqual({
        kind: "unavailable",
        reason: "malformed_response",
      });
    }
  });

  it("fails closed when the latest view height is behind the transaction block", async () => {
    const provider = new HttpTronConfirmationDepthProvider(
      new FakeLatestBlockTransport(block(69_999_999)),
    );

    await expect(
      provider.getConfirmationDepth({
        view: "solidified",
        transactionBlockNumber: "70000000",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed_response",
    });
  });

  it("rejects malformed transaction block numbers", async () => {
    const transport = new FakeLatestBlockTransport(
      block(70_000_000),
    );
    const provider = new HttpTronConfirmationDepthProvider(
      transport,
    );

    for (const transactionBlockNumber of [
      "-1",
      "01",
      "1.5",
      "not-a-height",
    ]) {
      await expect(
        provider.getConfirmationDepth({
          view: "head",
          transactionBlockNumber,
        }),
      ).resolves.toEqual({
        kind: "unavailable",
        reason: "malformed_response",
      });
    }

    expect(transport.calls).toHaveLength(0);
  });
});
