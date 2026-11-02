import { describe, it, expect } from "vitest";
import { tripCo2, CO2_G_PER_KM } from "../src/util/eco";

describe("trip CO₂", () => {
  it("scales each mode's ADEME factor by the distance", () => {
    const co2 = tripCo2(660);
    expect(co2.km).toBe(660);
    expect(co2.train).toBeCloseTo(1.518, 3);
    expect(co2.car).toBeCloseTo(72.996, 3);
    expect(co2.plane).toBeCloseTo(147.972, 3);
  });

  it("keeps the train about 50 times below driving and 100 times below flying", () => {
    expect(Math.round(CO2_G_PER_KM.car / CO2_G_PER_KM.train)).toBe(48);
    expect(Math.round(CO2_G_PER_KM.plane / CO2_G_PER_KM.train)).toBe(97);
  });
});
