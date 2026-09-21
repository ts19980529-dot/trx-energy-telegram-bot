import {
  paymentIdentityOf,
  type PaymentFinalityVerifier,
  type PaymentIdentity,
  type PaymentObservation,
} from "../../core/payments/payment-observation.js";
import type {
  TronPaymentEvidenceReader,
  TronReadUnavailableReason,
} from "../../core/payments/tron-read-source.js";
import {
  normalizeTronPaymentEvidence,
  type TronAddressCodec,
} from "../../core/payments/tron-evidence-normalization.js";

export class TronReadAdapterError extends Error {
  constructor(readonly reason: TronReadUnavailableReason) {
    super(`TRON read adapter unavailable: ${reason}`);
    this.name = "TronReadAdapterError";
  }
}

function sameIdentity(
  expected: PaymentIdentity,
  actual: PaymentIdentity,
): boolean {
  if (expected.asset !== actual.asset || expected.txid !== actual.txid) {
    return false;
  }

  if (expected.asset === "TRX" && actual.asset === "TRX") {
    return true;
  }

  if (expected.asset === "USDT" && actual.asset === "USDT") {
    return (
      expected.tokenContractAddress === actual.tokenContractAddress &&
      expected.eventIndex === actual.eventIndex
    );
  }

  return false;
}

export class TronReadPaymentFinalityVerifier
  implements PaymentFinalityVerifier
{
  readonly name: string;

  constructor(
    private readonly reader: TronPaymentEvidenceReader,
    private readonly addressCodec: TronAddressCodec,
  ) {
    this.name = `tron-read:${reader.name}`;
  }

  async inspect(
    identity: PaymentIdentity,
  ): Promise<PaymentObservation | undefined> {
    const outcome = await this.reader.readPaymentEvidence({
      identity,
      view: "solidified",
    });

    if (outcome.kind === "not_found") {
      return undefined;
    }

    if (outcome.kind === "unavailable") {
      throw new TronReadAdapterError(outcome.reason);
    }

    const observation = normalizeTronPaymentEvidence(
      outcome.evidence,
      this.addressCodec,
    );

    if (observation === undefined || !observation.solidified) {
      throw new TronReadAdapterError("malformed_response");
    }

    const actualIdentity = paymentIdentityOf(observation);

    if (!sameIdentity(identity, actualIdentity)) {
      throw new TronReadAdapterError("malformed_response");
    }

    return observation;
  }
}
