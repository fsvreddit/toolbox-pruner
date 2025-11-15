import { TimePeriod, timePeriodToTimeStamp } from "./usernotePrune.js";

test("All time periods are mapped", () => {
    const periods = Object.values(TimePeriod);
    const unmappedPeriods: string[] = [];
    for (const period of periods) {
        try {
            timePeriodToTimeStamp(period as TimePeriod);
        } catch {
            unmappedPeriods.push(period);
        }
    }
    expect(unmappedPeriods).toEqual([]);
});
