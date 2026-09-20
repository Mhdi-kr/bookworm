import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import {
  extractSpeakableBlocks,
  normalizeSpeakable,
  speakableTextFromElement,
} from "./extract";
import { splitForTts } from "./split";

function doc(html: string): Document {
  return parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`).document as unknown as Document;
}

test("nested list items keep parent and child text", () => {
  const d = doc(`
    <ul>
      <li>Parent
        <ul>
          <li>Child</li>
        </ul>
      </li>
    </ul>
  `);
  assert.deepEqual(extractSpeakableBlocks(d), ["Parent", "Child"]);
});

test("li wrapping p is not duplicated", () => {
  const d = doc(`
    <ul>
      <li><p>Only once</p></li>
    </ul>
  `);
  assert.deepEqual(extractSpeakableBlocks(d), ["Only once"]);
});

test("div-based list items are speakable", () => {
  const d = doc(`
    <div role="list">
      <div role="listitem">First point</div>
      <div>Second point</div>
    </div>
  `);
  assert.deepEqual(extractSpeakableBlocks(d), ["First point", "Second point"]);
});

test("figure captions are speakable", () => {
  const d = doc(`
    <figure>
      <img alt="" src="x.png"/>
      <figcaption>A river at dusk</figcaption>
    </figure>
  `);
  assert.deepEqual(extractSpeakableBlocks(d), ["A river at dusk"]);
});

test("code listings stay silent", () => {
  const d = doc(`
    <p>Before</p>
    <pre class="programlisting">fn main() {}</pre>
    <p>After</p>
  `);
  assert.deepEqual(extractSpeakableBlocks(d), ["Before", "After"]);
});

test("normalizeSpeakable strips decorative bullets but keeps Catalan middle-dots", () => {
  assert.equal(normalizeSpeakable("• First item"), "First item");
  assert.equal(normalizeSpeakable("▪  Second"), "Second");
  assert.equal(normalizeSpeakable("- dashed item"), "dashed item");
  assert.equal(normalizeSpeakable("12"), "");
  assert.equal(normalizeSpeakable("Col·legi"), "Col·legi");
});

test("splitForTts does not break numbered list prefixes", () => {
  assert.deepEqual(splitForTts("1. First item. Next sentence."), [
    "1. First item.",
    "Next sentence.",
  ]);
  assert.deepEqual(splitForTts("• Hello world."), ["Hello world."]);
});

test("speakableTextFromElement ignores nested items", () => {
  const d = doc(`<ul><li id="p">Parent<ul><li>Child</li></ul></li></ul>`);
  const parent = d.getElementById("p");
  assert.ok(parent);
  assert.equal(speakableTextFromElement(parent), "Parent");
});
