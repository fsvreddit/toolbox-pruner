import { vi } from "vitest";

vi.hoisted(() => {
    // @ts-expect-error config stub for tests
    globalThis.devvit = { config: {} };
});

vi.mock("@devvit/web/server", () => ({
    context: {
        subredditId: "t5_test",
        subredditName: "BotBouncer",
    },
    redis: {},
}));

vi.mock("@fsvreddit/fsv-devvit-web-helpers", () => ({
    getExtendedDevvit: vi.fn(),
    hasEventBeenHandled: vi.fn(),
}));

import { TimePeriod, timePeriodToTimeStamp } from "./usernotePrune.js";

test("All time periods are mapped", () => {
    const periods = Object.values(TimePeriod);
    const unmappedPeriods: string[] = [];
    for (const period of periods) {
        try {
            timePeriodToTimeStamp(period);
        } catch {
            unmappedPeriods.push(period);
        }
    }
    expect(unmappedPeriods).toEqual([]);
});
