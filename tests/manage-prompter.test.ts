import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { PromptBackError, PromptClosedError, Prompter } from "@/modules/manage/prompter";
import type { SelectItem } from "@/modules/manage/prompter";

const ESC = "\u001b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const LEFT = `${ESC}[D`;
const HOME = `${ESC}[H`;
const END = `${ESC}[F`;
const DELETE = `${ESC}[3~`;
const BACKSPACE = "\u007f";
const CTRL_U = "\u0015";
const ENTER = "\r";
const CTRL_C = "\u0003";

type Value = "alpha" | "beta" | "gamma" | "back";

const ITEMS: SelectItem<Value>[] = [
    { value: "alpha", label: "Alpha" },
    { separator: true },
    { value: "beta", label: "Beta", hint: "the second" },
    { value: "gamma", label: "Gamma", key: "g" },
];

/** A stream pair that looks like a terminal: `isTTY`, raw mode, a width. */
function createTerminal(): { input: PassThrough; output: PassThrough; rawModes: boolean[]; screen: () => string } {
    const rawModes: boolean[] = [];
    const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: (mode: boolean) => {
            rawModes.push(mode);
        },
    });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });

    let written = "";
    output.on("data", (chunk: Buffer) => {
        written += chunk.toString();
    });

    return { input: input, output: output, rawModes: rawModes, screen: () => written };
}

/** Types keys one at a time, letting the prompt redraw between them as a person would. */
async function press(input: PassThrough, ...keys: string[]): Promise<void> {
    for(const key of keys) {
        input.write(key);
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

describe("Prompter.select on a terminal", () => {
    it("moves with the arrow keys, skipping separators", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const picked = prompter.select("Pick", ITEMS);
        await press(terminal.input, DOWN, DOWN, ENTER);

        expect(await picked).toBe("gamma");
    });

    it("wraps around from the first choice to the last", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const picked = prompter.select("Pick", ITEMS);
        await press(terminal.input, UP, ENTER);

        expect(await picked).toBe("gamma");
    });

    it("starts on the default and jumps by number", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const onDefault = prompter.select("Pick", ITEMS, { defaultValue: "beta" });
        await press(terminal.input, ENTER);
        expect(await onDefault).toBe("beta");

        const byNumber = prompter.select("Pick", ITEMS);
        await press(terminal.input, "3", ENTER);
        expect(await byNumber).toBe("gamma");
    });

    it("returns the cancel value on Esc, and reports Esc as 'back' when there is none", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const cancellable = prompter.select("Pick", [...ITEMS, { value: "back", label: "Back" }], { cancelValue: "back" });
        await press(terminal.input, ESC);
        expect(await cancellable).toBe("back");

        const rejected = expect(prompter.select("Pick", ITEMS)).rejects.toBeInstanceOf(PromptBackError);
        await press(terminal.input, ESC);
        await rejected;
        expect(terminal.rawModes).toEqual([true, false, true, false]);
    });

    it("leaves one summary line behind and hands the terminal back", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const picked = prompter.select("Authentication", ITEMS);
        await press(terminal.input, DOWN, ENTER);
        await picked;

        expect(stripAnsi(terminal.screen())).toMatch(/[✔√] Authentication · Beta\n$/);
        expect(terminal.rawModes).toEqual([true, false]);
        expect(terminal.screen()).toContain(`${ESC}[?25h`);
    });

    it("treats Ctrl+C as leaving and restores the terminal", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        // The rejection lands mid-`press`, so the expectation has to be listening first.
        const rejected = expect(prompter.select("Pick", ITEMS)).rejects.toBeInstanceOf(PromptClosedError);
        await press(terminal.input, CTRL_C);

        await rejected;
        expect(terminal.rawModes).toEqual([true, false]);
    });
});

describe("Prompter text prompts on a terminal", () => {
    it("collapses an answered question into a summary line", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const answer = prompter.ask("Host", "10.0.0.5");
        await press(terminal.input, "\n");

        expect(await answer).toBe("10.0.0.5");
        expect(stripAnsi(terminal.screen())).toMatch(/[✔√] Host · 10\.0\.0\.5\n$/);
    });

    it("edits the line in place: cursor keys, Delete, Home / End, Ctrl+U", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const edited = prompter.ask("Host");
        // "10.0.5" → ← ← inserts ".0" → "10.0.0.5"; Home + Delete drops the leading "1"; End appends ":22"
        await press(terminal.input, "1", "0", ".", "0", ".", "5", LEFT, LEFT, ".", "0", HOME, DELETE, END, ":", "2", "2", ENTER);
        expect(await edited).toBe("0.0.0.5:22");

        const cleared = prompter.ask("Host");
        await press(terminal.input, "x", "y", CTRL_U, "z", BACKSPACE, "w", ENTER);
        expect(await cleared).toBe("w");

        expect(stripAnsi(terminal.screen())).toMatch(/[✔√] Host · 0\.0\.0\.5:22\n/);
        expect(terminal.rawModes).toEqual([true, false, true, false]);
    });

    it("reports Esc in a text field as 'back', with nothing typed into a value", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const rejected = expect(prompter.ask("Host", "10.0.0.5")).rejects.toBeInstanceOf(PromptBackError);
        await press(terminal.input, "1", "0", ESC);
        await rejected;

        expect(terminal.rawModes).toEqual([true, false]);
        expect(stripAnsi(terminal.screen())).not.toMatch(/[✔√] Host/);
    });

    it("reads yes / no in raw mode too, so Esc works there", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const typed = prompter.askYesNo("Write it?", true);
        await press(terminal.input, "n", ENTER);
        expect(await typed).toBe(false);

        const defaulted = prompter.askYesNo("Write it?", true);
        await press(terminal.input, ENTER);
        expect(await defaulted).toBe(true);

        const rejected = expect(prompter.askYesNo("Write it?", true)).rejects.toBeInstanceOf(PromptBackError);
        await press(terminal.input, ESC);
        await rejected;

        expect(stripAnsi(terminal.screen())).toMatch(/[✔√] Write it\? · no\n.*[✔√] Write it\? · yes\n/s);
    });

    it("reports Esc in a secret as 'back'", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const rejected = expect(prompter.askSecret("Password")).rejects.toBeInstanceOf(PromptBackError);
        await press(terminal.input, "h", "u", ESC);
        await rejected;

        expect(terminal.rawModes).toEqual([true, false]);
        expect(terminal.screen()).not.toContain("hu");
    });

    it("never echoes a secret, and honours backspace", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const secret = prompter.askSecret("Password");
        await press(terminal.input, "h", "u", "n", "t", "e", "x", "\u007f", "r", "2", ENTER);

        expect(await secret).toBe("hunter2");
        expect(terminal.screen()).not.toContain("hunter");
        expect(terminal.rawModes).toEqual([true, false]);
    });
});

describe("Prompter.pause after a report", () => {
    it("keeps the next menu hidden until Enter and restores raw mode", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);
        prompter.write("Connection failed: the server refused the connection.\n");

        const next = (async () => {
            await prompter.pause();
            return prompter.select("Next menu", ITEMS);
        })();
        await press(terminal.input, DOWN);

        expect(stripAnsi(terminal.screen())).toContain("Press Enter to continue");
        expect(terminal.screen()).not.toContain("Next menu");
        expect(terminal.rawModes).toEqual([true]);

        await press(terminal.input, ENTER);
        expect(terminal.screen()).toContain("Next menu");
        await press(terminal.input, ENTER);
        expect(await next).toBe("alpha");
        expect(terminal.rawModes).toEqual([true, false, true, false]);
    });

    it("lets Esc go back and Ctrl+C cancel without continuing", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);

        const back = expect(prompter.pause()).rejects.toBeInstanceOf(PromptBackError);
        await press(terminal.input, ESC);
        await back;

        const cancelled = expect(prompter.pause()).rejects.toBeInstanceOf(PromptClosedError);
        await press(terminal.input, CTRL_C);
        await cancelled;
        expect(terminal.rawModes).toEqual([true, false, true, false]);
    });

    it("handles input ending during and before a pause", async () => {
        const terminal = createTerminal();
        const prompter = new Prompter(terminal.input, terminal.output);
        const closed = expect(prompter.pause()).rejects.toBeInstanceOf(PromptClosedError);
        terminal.input.end();
        await closed;
        await expect(prompter.pause()).rejects.toBeInstanceOf(PromptClosedError);
        expect(terminal.rawModes).toEqual([true, false]);
    });

    it("does not consume a scripted answer or print a pause off a terminal", async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        let screen = "";
        output.on("data", (chunk: Buffer) => {
            screen += chunk.toString();
        });
        const prompter = new Prompter(input, output);
        input.end("beta\n");

        await prompter.pause();
        expect(screen).toBe("");
        expect(await prompter.select("Pick", ITEMS)).toBe("beta");
    });
});

describe("Prompter.select off a terminal", () => {
    it("numbers the choices and accepts a number, a key or a label", async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        let screen = "";
        output.on("data", (chunk: Buffer) => {
            screen += chunk.toString();
        });
        input.write("2\ng\nalpha\n\nnope\n1\n");

        const prompter = new Prompter(input, output);

        expect(await prompter.select("Pick", ITEMS)).toBe("beta");
        expect(await prompter.select("Pick", ITEMS)).toBe("gamma");
        expect(await prompter.select("Pick", ITEMS)).toBe("alpha");
        expect(await prompter.select("Pick", ITEMS, { defaultValue: "gamma" })).toBe("gamma");
        expect(await prompter.select("Pick", ITEMS)).toBe("alpha");

        expect(screen).toContain("   2) Beta   the second");
        expect(screen).toContain("Pick a number from 1 to 3.");
        expect(screen).not.toContain(ESC);
    });

    it("takes a line of just Esc as the Esc key, in a list and in a text field", async () => {
        const input = new PassThrough();
        const output = new PassThrough();
        input.write(`${ESC}\nESC\n${ESC}\n`);

        const prompter = new Prompter(input, output);

        expect(await prompter.select("Pick", [...ITEMS, { value: "back", label: "Back" }], { cancelValue: "back" })).toBe("back");
        await expect(prompter.select("Pick", ITEMS)).rejects.toBeInstanceOf(PromptBackError);
        await expect(prompter.ask("Host")).rejects.toBeInstanceOf(PromptBackError);
    });
});
