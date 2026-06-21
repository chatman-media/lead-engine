import { describe, expect, it } from "bun:test";
import { operatorLabel, pickLeastBusyOperator } from "./assign-operator.ts";
import type { Db } from "./dal/types.ts";

describe("operatorLabel", () => {
  it("имя приоритетнее", () => {
    expect(operatorLabel({ name: "Иван", email: "i@x.io", adminId: 1 })).toBe("Иван");
  });
  it("нет имени → @local-part email", () => {
    expect(operatorLabel({ name: null, email: "bob@x.io", adminId: 1 })).toBe("@bob");
    expect(operatorLabel({ name: "  ", email: "bob@x.io", adminId: 1 })).toBe("@bob");
  });
  it("нет имени и пустой local → 'оператор #id'", () => {
    expect(operatorLabel({ name: null, email: "@x.io", adminId: 9 })).toBe("оператор #9");
  });
});

// tx фейкается: каждый select() отдаёт следующий результат из очереди.
// Чейн поддерживает from/innerJoin/where/groupBy и awaitable через then.
function fakeTx(queue: unknown[][]): Db {
  const q = [...queue];
  const chain = (result: unknown[]) => {
    const p = Promise.resolve(result);
    const node: Record<string, unknown> = {
      from: () => node,
      innerJoin: () => node,
      where: () => node,
      groupBy: () => node,
      then: p.then.bind(p),
    };
    return node;
  };
  return { select: () => chain(q.shift() ?? []) } as unknown as Db;
}

describe("pickLeastBusyOperator", () => {
  it("нет кандидатов → null", async () => {
    const out = await pickLeastBusyOperator(fakeTx([[]]), 1);
    expect(out).toBeNull();
  });

  it("least-busy: меньшая нагрузка побеждает (line 78 load.set)", async () => {
    const tx = fakeTx([
      [
        { adminId: 1, name: "A", email: "a@x.io" },
        { adminId: 2, name: "B", email: "b@x.io" },
      ],
      [
        { adminId: 1, open: 5 },
        { adminId: 2, open: 1 },
      ],
    ]);
    const out = await pickLeastBusyOperator(tx, 1);
    expect(out).toEqual({ adminId: 2, label: "B" });
  });

  it("eligibleAdminIds сужает пул (lines 59-61)", async () => {
    const tx = fakeTx([
      [
        { adminId: 1, name: "A", email: "a@x.io" },
        { adminId: 2, name: "B", email: "b@x.io" },
      ],
      [{ adminId: 1, open: 0 }],
    ]);
    // оператор 1 свободнее, но eligible=[2] → выбираем 2
    const out = await pickLeastBusyOperator(tx, 1, { eligibleAdminIds: [2] });
    expect(out?.adminId).toBe(2);
  });

  it("eligibleAdminIds не пересекается с пулом → fallback на всех", async () => {
    const tx = fakeTx([[{ adminId: 1, name: "A", email: "a@x.io" }], []]);
    // eligible=[99] не совпадает → filtered пуст → остаётся весь пул
    const out = await pickLeastBusyOperator(tx, 1, { eligibleAdminIds: [99] });
    expect(out?.adminId).toBe(1);
  });
});
