export interface FeatureFlags {
  readonly usdtToTrxExchange: boolean;
  readonly bandwidthSubsidy: boolean;
  readonly idlePackageDeduction: boolean;
  readonly thirdPartyEnergySupplier: boolean;
  readonly ownEnergyPool: boolean;
  readonly referralSystem: boolean;
  readonly premiumService: boolean;
}

export const defaultFeatureFlags: FeatureFlags = {
  usdtToTrxExchange: false,
  bandwidthSubsidy: false,
  idlePackageDeduction: false,
  thirdPartyEnergySupplier: false,
  ownEnergyPool: false,
  referralSystem: false,
  premiumService: false,
};
