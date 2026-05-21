import { describe, expect, it } from "bun:test";
import { JsonLogger } from "./logger.ts";

class BufferStream {
  public lines: string[] = [];
  write(chunk: string): void {
    this.lines.push(chunk);
  }
}

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line.replace(/\n$/, "")) as Record<string, unknown>;
}

describe("JsonLogger", () => {
  it("пишет одну JSON-строку на каждый emit", () => {
    const buf = new BufferStream();
    const log = new JsonLogger({ stream: buf, minLevel: "debug" });
    log.info("hello", { foo: 1 });
    expect(buf.lines).toHaveLength(1);
    expect(buf.lines[0]?.endsWith("\n")).toBe(true);
    const r = parse(buf.lines[0]!);
    expect(r).toMatchObject({ level: "info", msg: "hello", foo: 1 });
    expect(typeof r.ts).toBe("string");
  });

  it("включает scope в record когда задан", () => {
    const buf = new BufferStream();
    const log = new JsonLogger({ stream: buf, scope: "apps/api", minLevel: "debug" });
    log.info("x");
    expect(parse(buf.lines[0]!)).toMatchObject({ scope: "apps/api" });
  });

  it("child добавляет к scope", () => {
    const buf = new BufferStream();
    const log = new JsonLogger({ stream: buf, scope: "apps/api", minLevel: "debug" });
    log.child("webhook").info("x");
    expect(parse(buf.lines[0]!)).toMatchObject({ scope: "apps/api/webhook" });
  });

  it("фильтрует ниже minLevel", () => {
    const buf = new BufferStream();
    const log = new JsonLogger({ stream: buf, minLevel: "warn" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(buf.lines).toHaveLength(2);
    expect(parse(buf.lines[0]!).level).toBe("warn");
    expect(parse(buf.lines[1]!).level).toBe("error");
  });

  it("Error в fields рендерится как { message, stack, name }", () => {
    const buf = new BufferStream();
    const log = new JsonLogger({ stream: buf, minLevel: "debug" });
    const err = new Error("boom");
    log.error("failed", { err });
    const r = parse(buf.lines[0]!);
    const errOut = r.err as { message: string; name: string; stack: string };
    expect(errOut.message).toBe("boom");
    expect(errOut.name).toBe("Error");
    expect(typeof errOut.stack).toBe("string");
  });

  it("по умолчанию minLevel='info' — debug отбрасывается", () => {
    const buf = new BufferStream();
    const log = new JsonLogger({ stream: buf });
    log.debug("d");
    log.info("i");
    expect(buf.lines).toHaveLength(1);
    expect(parse(buf.lines[0]!).msg).toBe("i");
  });
});
