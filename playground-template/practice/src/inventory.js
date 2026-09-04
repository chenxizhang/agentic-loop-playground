export function reserveStock(available, requested) {
  if (!Number.isInteger(available) || !Number.isInteger(requested)) {
    throw new TypeError("Stock values must be integers");
  }
  if (requested < 0) {
    throw new RangeError("Requested stock cannot be negative");
  }

  return available + requested;
}

