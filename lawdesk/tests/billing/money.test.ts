import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyBp,
  billedMinutes,
  divRoundHalfUp,
  expenseAmount,
  formatCents,
  hoursLabel,
  parseDollars,
  timeAmount,
} from "../../src/billing/money.ts";
import { agingBucket } from "../../src/billing/billing.ts";

test("money: half-up division rounds halves away from zero", () => {
  assert.equal(divRoundHalfUp(5, 2), 3);
  assert.equal(divRoundHalfUp(4, 2), 2);
  assert.equal(divRoundHalfUp(14, 10), 1);
  assert.equal(divRoundHalfUp(15, 10), 2);
  assert.equal(divRoundHalfUp(-15, 10), -2);
  assert.equal(divRoundHalfUp(-14, 10), -1);
  assert.equal(divRoundHalfUp(0, 7), 0);
  assert.throws(() => divRoundHalfUp(1, 0));
  assert.throws(() => divRoundHalfUp(1.5, 2));
});

test("money: time rounds UP to the 6-minute increment per entry", () => {
  assert.equal(billedMinutes(0), 0);
  assert.equal(billedMinutes(1), 6);
  assert.equal(billedMinutes(6), 6);
  assert.equal(billedMinutes(7), 12);
  assert.equal(billedMinutes(59), 60);
  assert.equal(billedMinutes(61), 66);
  assert.equal(billedMinutes(14, 15), 15); // quarter-hour firms
  assert.equal(billedMinutes(16, 15), 30);
  assert.throws(() => billedMinutes(-1));
  assert.throws(() => billedMinutes(1.5));
});

test("money: rate x hours rounds half-up to the cent", () => {
  assert.equal(timeAmount(30000, 6), 3000); // $300/h x 0.1 h = $30.00
  assert.equal(timeAmount(25025, 6), 2503); // $250.25 x 0.1 = 2502.5c -> 2503c
  assert.equal(timeAmount(25024, 6), 2502); // 2502.4c -> 2502c
  assert.equal(timeAmount(19999, 18), 6000); // $199.99 x 0.3 = 5999.7c -> 6000c
  assert.equal(timeAmount(33333, 6), 3333); // 3333.3c
  assert.equal(timeAmount(33335, 6), 3334); // 3333.5c
  assert.equal(timeAmount(12345, 0), 0);
  assert.equal(timeAmount(17500, 90), 26250); // 1.5 h
  // 15-minute increments: $250.10 x 0.25 h = 6252.5c -> 6253c
  assert.equal(timeAmount(25010, 15), 6253);
});

test("money: basis points, markup, formatting and parsing", () => {
  assert.equal(applyBp(10000, 1000), 1000); // 10% of $100
  assert.equal(applyBp(105, 1000), 11); // 10.5c -> 11c
  assert.equal(applyBp(104, 1000), 10);
  assert.equal(applyBp(1, 5000), 1); // 0.5c -> 1c
  assert.equal(applyBp(999, 875), 87); // 8.75% of 9.99 = 87.4125c
  assert.equal(expenseAmount(1999, 0), 1999);
  assert.equal(expenseAmount(1999, 1500), 2299); // +299.85c -> 300c
  assert.equal(formatCents(123456), "$1,234.56");
  assert.equal(formatCents(5), "$0.05");
  assert.equal(formatCents(-5), "-$0.05");
  assert.equal(formatCents(100000000), "$1,000,000.00");
  assert.equal(parseDollars("1,234.5"), 123450);
  assert.equal(parseDollars("$12"), 1200);
  assert.equal(parseDollars("0.05"), 5);
  assert.throws(() => parseDollars("1.234"));
  assert.throws(() => parseDollars("abc"));
  assert.equal(hoursLabel(6), "0.1");
  assert.equal(hoursLabel(90), "1.5");
  assert.equal(hoursLabel(60), "1.0");
  assert.equal(hoursLabel(20), "0.33");
});

test("aging buckets on their boundary days", () => {
  assert.equal(agingBucket(-5), "current");
  assert.equal(agingBucket(0), "current"); // due today
  assert.equal(agingBucket(1), "d1_30");
  assert.equal(agingBucket(30), "d1_30");
  assert.equal(agingBucket(31), "d31_60");
  assert.equal(agingBucket(60), "d31_60");
  assert.equal(agingBucket(61), "d61_90");
  assert.equal(agingBucket(90), "d61_90");
  assert.equal(agingBucket(91), "d90_plus");
});
