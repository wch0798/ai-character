import {
  describe,
  expect,
  it,
} from "vitest";

import {
  clampChatHeight,
  readChatHeight,
} from "../chat-resize";

describe("chat resize", () => {
  it("기본 높이는 260이다", () => {
    expect(
      readChatHeight(null)
    ).toBe(260);
  });

  it("최소 높이는 160이다", () => {
    expect(
      clampChatHeight(80)
    ).toBe(160);
  });

  it("최대 높이는 520이다", () => {
    expect(
      clampChatHeight(900)
    ).toBe(520);
  });

  it("저장된 정상 높이를 복원한다", () => {
    expect(
      readChatHeight("380")
    ).toBe(380);
  });
});
