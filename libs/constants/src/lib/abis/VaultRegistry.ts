export const vaultRegistryAbi = [
	{
		inputs: [
			{
				internalType: 'address',
				name: 'vault_',
				type: 'address',
			},
		],
		stateMutability: 'nonpayable',
		type: 'constructor',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
		],
		name: 'VaultDelisted',
		type: 'event',
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
		],
		name: 'VaultListed',
		type: 'event',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'token',
				type: 'address',
			},
		],
		name: 'collateralIdOf',
		outputs: [
			{
				internalType: 'bytes32',
				name: '',
				type: 'bytes32',
			},
		],
		stateMutability: 'pure',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'token',
				type: 'address',
			},
		],
		name: 'collateralTypeOf',
		outputs: [
			{
				components: [
					{
						internalType: 'address',
						name: 'token',
						type: 'address',
					},
					{
						internalType: 'uint256',
						name: 'minRatio',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'liquidationRatio',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'liquidationPenalty',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'debtCeiling',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'totalDebt',
						type: 'uint256',
					},
					{
						internalType: 'bool',
						name: 'active',
						type: 'bool',
					},
				],
				internalType: 'struct VaultRegistry.CollateralType',
				name: '',
				type: 'tuple',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
		],
		name: 'isLiquidatable',
		outputs: [
			{
				internalType: 'bool',
				name: '',
				type: 'bool',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
		],
		name: 'isVaultOwner',
		outputs: [
			{
				internalType: 'bool',
				name: '',
				type: 'bool',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'offset',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'limit',
				type: 'uint256',
			},
		],
		name: 'liquidatableVaults',
		outputs: [
			{
				internalType: 'address[]',
				name: 'found',
				type: 'address[]',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
			{
				internalType: 'bool',
				name: 'empty',
				type: 'bool',
			},
		],
		name: 'onVaultChanged',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
		],
		name: 'sync',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address[]',
				name: 'owners',
				type: 'address[]',
			},
		],
		name: 'syncMany',
		outputs: [],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [],
		name: 'vault',
		outputs: [
			{
				internalType: 'contract IGoldVaultView',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'index',
				type: 'uint256',
			},
		],
		name: 'vaultOwnerAt',
		outputs: [
			{
				internalType: 'address',
				name: '',
				type: 'address',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'vaultOwnerCount',
		outputs: [
			{
				internalType: 'uint256',
				name: '',
				type: 'uint256',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'uint256',
				name: 'offset',
				type: 'uint256',
			},
			{
				internalType: 'uint256',
				name: 'limit',
				type: 'uint256',
			},
		],
		name: 'vaultOwners',
		outputs: [
			{
				internalType: 'address[]',
				name: 'page',
				type: 'address[]',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{
				internalType: 'address',
				name: 'owner',
				type: 'address',
			},
		],
		name: 'vaultSummary',
		outputs: [
			{
				components: [
					{
						internalType: 'address',
						name: 'token',
						type: 'address',
					},
					{
						internalType: 'uint256',
						name: 'collateral',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'debt',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'ratio',
						type: 'uint256',
					},
					{
						internalType: 'uint256',
						name: 'liquidationPrice',
						type: 'uint256',
					},
					{
						internalType: 'bool',
						name: 'liquidatable',
						type: 'bool',
					},
				],
				internalType: 'struct VaultRegistry.VaultSummary',
				name: 's',
				type: 'tuple',
			},
		],
		stateMutability: 'view',
		type: 'function',
	},
] as const;
