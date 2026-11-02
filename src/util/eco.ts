/**
 * CO₂ per passenger for one trip, by mode, from ADEME's Impact CO₂ figures
 * (impactco2.fr, "transport" comparator; per passenger-km, construction included).
 * Train: TGV. Car: a thermal car with the driver alone. Plane: short-haul, with
 * contrails. Distances are straight-line, the same for every mode, so the ratios
 * hold even though real rail and road routes are longer.
 */
export const CO2_G_PER_KM = { train: 2.3, car: 110.6, plane: 224.2 } as const;

export interface TripCo2 {
  km: number;
  train: number;
  car: number;
  plane: number;
}

/** Kilograms of CO₂e for `km` by each mode. */
export function tripCo2(km: number): TripCo2 {
  const kg = (g: number) => (km * g) / 1000;
  return { km, train: kg(CO2_G_PER_KM.train), car: kg(CO2_G_PER_KM.car), plane: kg(CO2_G_PER_KM.plane) };
}
