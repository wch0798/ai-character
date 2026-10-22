import { describe, expect, it } from "vitest";
import { parseMarkdown, splitTableRow } from "../chat-markdown";

const PRICE_ANSWER = [
  "중고 본체 기준으로 약 40만~50만 원 정도로 예상됩니다.",
  "",
  "| 거래 조건 | 예상 가격 |",
  "|---|---:|",
  "| 빨리 판매할 때 | 35만~40만 원 |",
  "| 일반적인 개인 거래 | 40만~45만 원 |",
  "| 보드·파워가 좋은 제품이고 상태가 좋을 때 | 45만~50만 원 |",
  "",
  "메인보드 모델을 알려주시면 범위를 더 좁혀드릴 수 있어요.",
].join("\n");

describe("markdown tables in chat replies", () => {
  it("turn a pipe table into a table block instead of raw | lines", () => {
    const blocks = parseMarkdown(PRICE_ANSWER);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "table", "paragraph"]);
    const table = blocks[1];
    if (table.type !== "table") throw new Error("expected a table");
    expect(table.align).toEqual(["left", "right"]);
    expect(table.header).toEqual([[{ type: "text", text: "거래 조건" }], [{ type: "text", text: "예상 가격" }]]);
    expect(table.rows).toHaveLength(3);
    expect(table.rows[2][1]).toEqual([{ type: "text", text: "45만~50만 원" }]);
  });

  it("keeps escaped bars inside a cell and pads short rows", () => {
    expect(splitTableRow("| a \\| b | c |")).toEqual(["a | b", "c"]);
    const blocks = parseMarkdown("| a | b |\n|:-:|---|\n| only |");
    const table = blocks[0];
    if (table.type !== "table") throw new Error("expected a table");
    expect(table.align).toEqual(["center", "left"]);
    expect(table.rows[0]).toHaveLength(2);
  });

  it("leaves ordinary text with a bar alone and reads --- as a divider", () => {
    expect(parseMarkdown("A | B 둘 중 하나").map((block) => block.type)).toEqual(["paragraph"]);
    expect(parseMarkdown("위\n\n---\n\n아래").map((block) => block.type)).toEqual(["paragraph", "rule", "paragraph"]);
  });
});
