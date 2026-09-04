import test from "node:test";
import assert from "node:assert/strict";
import { reserveStock } from "../src/inventory.js";

test("reservation subtracts the requested quantity", () => {
  assert.equal(reserveStock(10, 3), 7);
});

test("reservation cannot exceed available stock", () => {
  assert.throws(() => reserveStock(2, 3), /available stock/i);
});

test("zero quantity leaves stock unchanged", () => {
  assert.equal(reserveStock(5, 0), 5);
});

test("stock values must be non-negative integers", () => {
  assert.throws(() => reserveStock(-1, 0), /negative/i);
  assert.throws(() => reserveStock(3.5, 1), /integers/i);
});

