import { describe, expect, it } from "vitest";
import { emptySnapshot, type ProductSnapshot } from "@98plus/product-model";
import { toTestUiDiagnostics } from "./diagnostics.ts";

function preContact(controlState: ProductSnapshot["controlState"]): ProductSnapshot {
  return { ...emptySnapshot(), controlState };
}

describe("pre-contact RIM diagnostics", () => {
  it("exposes RIM.CHAT with a null domain chat and no synthesized chat fields", () => {
    const diagnostics = toTestUiDiagnostics({
      currentUserId: "user-a",
      snapshot: preContact("RIM.CHAT"),
      revision: 3,
    });
    expect(diagnostics.controlState).toBe("RIM.CHAT");
    expect(diagnostics.rimChat).toBeNull();
    expect(diagnostics.savedFrozenRimChatPresent).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toContain("rim-chat-");
    expect(JSON.stringify(diagnostics)).not.toContain("выбери человека и я предложу новые запреты");
  });

  it("exposes RIM.SELECT_CONTACT with a null domain chat", () => {
    const diagnostics = toTestUiDiagnostics({
      currentUserId: "user-a",
      snapshot: preContact("RIM.SELECT_CONTACT"),
      revision: 4,
    });
    expect(diagnostics.controlState).toBe("RIM.SELECT_CONTACT");
    expect(diagnostics.rimChat).toBeNull();
  });
});
