import test from "node:test";
import assert from "node:assert/strict";
import { reserveStock } from "../../practice/src/inventory.js";

test("contract: reservation subtracts the requested quantity", () => {
  assert.equal(reserveStock(10, 3), 7);
});

test("contract: reservation cannot exceed available stock", () => {
  assert.throws(() => reserveStock(2, 3), /available stock/i);
});

test("contract: zero quantity leaves stock unchanged", () => {
  assert.equal(reserveStock(5, 0), 5);
});

test("contract: stock values must be non-negative integers", () => {
  assert.throws(() => reserveStock(-1, 0), /negative/i);
  assert.throws(() => reserveStock(3.5, 1), /integers/i);
});
