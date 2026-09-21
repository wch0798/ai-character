import {
  describe,
  expect,
  it,
} from "vitest";

import {
  chatAppWindowSize,
  clampChatHeight,
  clampChatSize,
  clampChatWidth,
  minChatAppWindowSize,
  minChatWidthForWorkArea,
  readChatHeight,
  readChatWidth,
  shouldApplyChatWindowSize,
} from "../chat-resize";

describe("chat resize", () => {
  it("기본 너비/높이를 복원한다", () => {
    expect(readChatWidth(null)).toBe(560);
    expect(readChatHeight(null)).toBe(420);
  });

  it("툴바가 한 줄로 남는 최소 너비 아래로는 줄이지 않는다", () => {
    expect(clampChatWidth(200)).toBe(480);
  });

  it("입력창과 메시지 칸이 남는 최소 높이 아래로는 줄이지 않는다", () => {
    expect(clampChatHeight(80)).toBe(280);
  });

  it("저장된 정상 크기를 복원한다", () => {
    expect(readChatWidth("640")).toBe(640);
    expect(readChatHeight("500")).toBe(500);
  });

  it("최대 크기를 넘기지 않는다", () => {
    expect(clampChatSize(2000, 2000)).toEqual({
      width: 1200,
      height: 900,
    });
  });

  it("채팅 모드 창은 캐릭터와 채팅을 붙여서 감싼다", () => {
    expect(minChatAppWindowSize(188)).toEqual({
      width: 680,
      height: 304,
    });
    expect(chatAppWindowSize(188, 560, 420)).toEqual({
      width: 760,
      height: 444,
    });
    expect(chatAppWindowSize(188, 560, 420, 520)).toEqual({
      width: 760,
      height: 532,
    });
    expect(chatAppWindowSize(188, 480, 280)).toEqual({
      width: 680,
      height: 304,
    });
    expect(chatAppWindowSize(188, 560, 420, 0, 40)).toEqual({
      width: 760,
      height: 484,
    });
  });

  it("채팅을 닫았다가 다시 열면 캐릭터 창 크기라도 채팅 창을 다시 키운다", () => {
    expect(
      shouldApplyChatWindowSize(
        { width: 760, height: 444 },
        { width: 220, height: 382 },
        { width: 760, height: 444 }
      )
    ).toBe(true);
    expect(
      shouldApplyChatWindowSize(
        { width: 760, height: 444 },
        { width: 760, height: 444 },
        { width: 760, height: 444 }
      )
    ).toBe(false);
  });

  it("shrinks the chat minimum on a small work area", () => {
    expect(minChatWidthForWorkArea(1920)).toBe(480);
    expect(minChatWidthForWorkArea(900)).toBe(378);
  });
});
