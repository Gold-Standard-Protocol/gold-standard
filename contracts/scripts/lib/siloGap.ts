/**
 * The verifier's view of the silo factory's deposit cursor.
 *
 * A deposit creates every silo missing up to the cursor. After governance moves the cursor
 * past a run of unusable silos (setCurrentSiloIndex) that can be more creations than one
 * transaction's gas allows, so the move is followed by createSilos in batches. These checks
 * fail a factory that cannot do that, and a token whose gap was left open. Nothing is missing
 * in ordinary running (a deposit creates the one silo it needs as it goes, and a token that
 * has never been deposited reports zero), so any figure above zero is an open gap.
 */
export const CREATE_BATCH = 16n;

export interface SiloGapCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

/** The two reads the checks need; a SiloFactory contract instance satisfies it. */
export interface SiloGapReader {
  MAX_CREATE_BATCH(): Promise<bigint>;
  missingSilos(token: string): Promise<bigint>;
}

export interface SiloGapToken {
  label: string;
  address: string;
}

const BATCH_CHECK = "ops:siloFactory.createSilos-batch-16";

export async function siloGapChecks(factory: SiloGapReader, tokens: readonly SiloGapToken[]): Promise<SiloGapCheck[]> {
  let batch: bigint;
  try {
    batch = await factory.MAX_CREATE_BATCH();
  } catch {
    // A factory without the constant has no createSilos either.
    return [{ name: BATCH_CHECK, pass: false, detail: "the factory has no createSilos: a long cursor move could stop deposits for good" }];
  }
  if (batch !== CREATE_BATCH) {
    return [{ name: BATCH_CHECK, pass: false, detail: `MAX_CREATE_BATCH is ${batch}, expected ${CREATE_BATCH}` }];
  }
  const checks: SiloGapCheck[] = [{ name: BATCH_CHECK, pass: true }];
  for (const token of tokens) {
    const name = `ops:siloFactory.${token.label}.no-silo-gap`;
    const missing = await factory.missingSilos(token.address);
    checks.push(
      missing === 0n
        ? { name, pass: true }
        : {
            name,
            pass: false,
            detail: `${missing} ${missing === 1n ? "silo is" : "silos are"} missing behind the deposit cursor; read missingSilos and call createSilos(${token.address}, ${CREATE_BATCH}) until it reads 0`,
          }
    );
  }
  return checks;
}
