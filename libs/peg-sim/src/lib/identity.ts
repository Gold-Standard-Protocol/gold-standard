import { totalPrincipal, borrowersHeld, type World } from './state';

/**
 * The conservation identity from docs/PEG_ARCHITECTURE.md §4:
 *
 *     totalSupply == Σ borrowerPrincipal
 *
 * Exactly the identity the Foundry suite proves today. The reserve holds GSUSD but
 * never issues it, so no term is needed for it. A violation is a modelling bug or an
 * accounting design flaw, and either is a reason to stop and look.
 */
export function identityHolds(world: World): boolean {
	return world.supply18 === totalPrincipal(world);
}

/**
 * Where every unit of supply sits. Independent of the identity above: it catches a
 * flow that moved GSUSD without updating a balance.
 *
 *     supply == holders + borrowersHeld + pool + gsrInventory + insurance
 */
export function ledgerBalances(world: World): boolean {
	const placed =
		world.ledgers.holdersGsusd18 +
		borrowersHeld(world) +
		world.pool.gsusd18 +
		world.gsr.gsusdInventory18 +
		world.insurance.gsusd18;
	return placed === world.supply18;
}

export function checkInvariants(world: World): void {
	if (!identityHolds(world)) world.ledgers.identityViolations += 1;
	if (!ledgerBalances(world)) world.ledgers.ledgerViolations += 1;
}
