export interface CatalogPackageConfig {
  readonly code: string;
  readonly count: number;
  readonly priceUsdtMicros: bigint;
  readonly enabled: boolean;
  readonly sortOrder: number;
}

export interface CatalogEnergyOptionConfig {
  readonly code: string;
  readonly energyAmount: bigint;
  readonly countCost: number;
  readonly enabled: boolean;
  readonly sortOrder: number;
}

export const catalogPackages: readonly CatalogPackageConfig[] = [
  { code: "count_10", count: 10, priceUsdtMicros: 17_000_000n, enabled: true, sortOrder: 10 },
  { code: "count_20", count: 20, priceUsdtMicros: 34_000_000n, enabled: true, sortOrder: 20 },
  { code: "count_50", count: 50, priceUsdtMicros: 85_000_000n, enabled: true, sortOrder: 50 },
  { code: "count_100", count: 100, priceUsdtMicros: 170_000_000n, enabled: true, sortOrder: 100 },
  { code: "count_200", count: 200, priceUsdtMicros: 340_000_000n, enabled: true, sortOrder: 200 },
  { code: "count_500", count: 500, priceUsdtMicros: 850_000_000n, enabled: true, sortOrder: 500 },
  { code: "count_1000", count: 1000, priceUsdtMicros: 1_700_000_000n, enabled: true, sortOrder: 1000 },
  { code: "count_1500", count: 1500, priceUsdtMicros: 2_600_000_000n, enabled: true, sortOrder: 1500 },
];

export const catalogEnergyOptions: readonly CatalogEnergyOptionConfig[] = [
  { code: "energy_65k", energyAmount: 65_000n, countCost: 1, enabled: true, sortOrder: 10 },
  { code: "energy_131k", energyAmount: 131_000n, countCost: 1, enabled: true, sortOrder: 20 },
];
