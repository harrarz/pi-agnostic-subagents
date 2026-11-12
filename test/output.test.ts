import assert from "node:assert/strict";
import { test } from "node:test";
import { formatOutput } from "../src/output.js";

test("pretty-prints JSON and JSONL without changing captured raw output", () => {
	assert.equal(formatOutput('{"answer":42}'), '{\n  "answer": 42\n}');
	assert.equal(formatOutput('{"type":"event","value":1}\nplain diagnostic'), '{\n  "type": "event",\n  "value": 1\n}\nplain diagnostic');
	assert.equal(formatOutput("unstructured diagnostic output"), "unstructured diagnostic output");
});

test("caps formatted previews and labels truncation without dropping the raw log", () => {
	const preview = formatOutput(JSON.stringify({ output: "x".repeat(200) }), 64);
	assert.ok(preview.length <= 64);
	assert.match(preview, /formatted preview truncated/);
});
