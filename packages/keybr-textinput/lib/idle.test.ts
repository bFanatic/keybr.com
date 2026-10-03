import { test } from "node:test";
import { deepEqual } from "rich-assert";
import { PauseCompensator } from "./idle.ts";

test("exclude long pauses from timestamps", () => {
  const pauses = new PauseCompensator(1000);
  deepEqual(pauses.adjust({ timeStamp: 100, timeToType: 50 }), {
    timeStamp: 100,
    timeToType: 50,
  });
  deepEqual(pauses.adjust({ timeStamp: 600, timeToType: 500 }), {
    timeStamp: 600,
    timeToType: 500,
  });
  // A pause of 10s only counts as 1s.
  deepEqual(pauses.adjust({ timeStamp: 10600, timeToType: 10000 }), {
    timeStamp: 1600,
    timeToType: 1000,
  });
  deepEqual(pauses.adjust({ timeStamp: 10800, timeToType: 200 }), {
    timeStamp: 1800,
    timeToType: 200,
  });
});

test("adjust keyboard events", () => {
  const pauses = new PauseCompensator(1000);
  deepEqual(pauses.adjust({ timeStamp: 0, code: "KeyA" }), {
    timeStamp: 0,
    code: "KeyA",
  });
  deepEqual(pauses.adjust({ timeStamp: 5000, code: "KeyB" }), {
    timeStamp: 1000,
    code: "KeyB",
  });
});
