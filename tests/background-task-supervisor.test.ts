import { describe, expect, it, vi } from "vitest";

import {
  RuntimeCapabilityGate,
  superviseBackgroundTask,
} from "../src/runtime/background-task-supervisor.js";

describe("background task supervision", () => {
  it("contains a fatal background failure and disables only its capability", async () => {
    const gate = new RuntimeCapabilityGate();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        superviseBackgroundTask(
          "payment-reconciliation",
          Promise.reject(new Error("sensitive internal detail")),
          () => gate.disable(),
        ),
      ).resolves.toBeUndefined();

      expect(gate.isAvailable()).toBe(false);
      expect(errorLog).toHaveBeenCalledWith(
        "Background task halted: task=payment-reconciliation; name=Error",
      );
      expect(String(errorLog.mock.calls[0]?.[0])).not.toContain(
        "sensitive internal detail",
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});
