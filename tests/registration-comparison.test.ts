import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { compareEntries } from "../src/modules/registration/comparison";
import { displayWidth, Prompter } from "../src/modules/manage/prompter";

describe("registration value comparison", () => {
    it("wraps long Korean descriptions without dropping their differing suffix or exposing credentials", () => {
        const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
        const output = Object.assign(new PassThrough(), { isTTY: true, columns: 48 });
        let text = "";
        output.on("data", (chunk) => { text += chunk; });
        const prompter = new Prompter(input, output);
        const prefix = "테스트 데이터베이스 설명 - 애플리케이션 연결에 사용하는 서버. ";
        const description = prefix + "이전 설명";
        const changed = prefix + "새 설명 (2026-10-11 이전 완료)";
        compareEntries(prompter, [
            { label: "Saved in AKMS", entry: { command: "npx", args: ["private-old-arg"], env: { DB_DESCRIPTION: description, DB_PASSWORD: "private-old-password" } } },
            { label: "Currently in Codex", entry: { command: "npx", args: ["private-new-arg"], env: { DB_DESCRIPTION: changed, DB_PASSWORD: "private-new-password" } } },
        ]);
        const plain = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
        for(const line of plain.split("\n")) expect(displayWidth(line)).toBeLessThan(48);
        expect(plain.replace(/\n {4}/g, "")).toContain(description);
        expect(plain.replace(/\n {4}/g, "")).toContain(changed);
        expect(plain).toContain("[1] Saved in AKMS");
        expect(plain).toContain("[2] Currently in Codex");
        expect(plain).toContain("Description");
        expect(plain).toContain("(hidden)");
        expect(text).not.toContain("private-");
        if(process.env.NO_COLOR == null) expect(text).toContain("\u001b[36m\u001b[1m새");
        prompter.close();
    });
});
