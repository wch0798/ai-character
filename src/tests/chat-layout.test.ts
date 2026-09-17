import {
  describe,
  expect,
  it,
} from "vitest";

import {
  getModelYForChat,
} from "../chat-layout";

describe("getModelYForChat", () => {
  it("채팅창 위로 캐릭터 발끝을 올린다", () => {
    expect(
      getModelYForChat(
        650,
        500,
        12
      )
    ).toBe(488);
  });

  it("이미 캐릭터가 위에 있으면 움직이지 않는다", () => {
    expect(
      getModelYForChat(
        420,
        500,
        12
      )
    ).toBe(420);
  });
});

import {
  getModelYFromBounds,
  getMaxChatHeightForCharacter,
} from "../chat-layout";

describe("chat character bounds layout", () => {
  it("캐릭터 실제 발끝을 채팅창 위로 이동한다", () => {
    expect(
      getModelYFromBounds(
        200,
        {
          y: 150,
          height: 300,
        },
        400,
        14
      )
    ).toBe(136);
  });

  it("캐릭터 전체 높이를 보존할 수 있는 채팅 최대 높이를 계산한다", () => {
    expect(
      getMaxChatHeightForCharacter(
        680,
        12,
        300,
        38
      )
    ).toBe(322);
  });
});
