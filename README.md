# @perkos/scheme-deferred

EIP-712 voucher-based deferred payment verification utilities for x402 deferred scheme. Provides signature verification, escrow balance checking, and voucher validation for off-chain payment aggregation.

## Installation

```bash
npm install @perkos/scheme-deferred
```

## Overview

The deferred scheme enables off-chain voucher signing with on-chain batch settlement:

1. **Client deposits** funds into escrow contract
2. **Client signs vouchers** (EIP-712) for each payment
3. **Facilitator verifies** signatures and escrow balance
4. **Seller claims vouchers** via escrow contract

## Usage

### Basic Verification

```typescript
import { DeferredSchemeVerifier } from '@perkos/scheme-deferred';
import type { DeferredPayload, PaymentRequirements } from '@perkos/scheme-deferred';

const verifier = new DeferredSchemeVerifier({
  network: 'base',
  escrowAddress: '0x...',
  rpcUrl: 'https://mainnet.base.org' // optional
});

const payload: DeferredPayload = {
  voucher: {
    id: '0x...',
    buyer: '0x...',
    seller: '0x...',
    valueAggregate: '5000000',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    timestamp: '1735689600',
    nonce: '1',
    escrow: '0x...',
    chainId: '8453'
  },
  signature: '0x...'
};

const requirements: PaymentRequirements = {
  scheme: 'deferred',
  network: 'base',
  maxAmountRequired: '1000000',
  resource: '/api/service',
  payTo: '0x...',
  maxTimeoutSeconds: 3600,
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
};

const result = await verifier.verify(payload, requirements);

if (result.isValid) {
  console.log('Valid voucher from:', result.payer);
} else {
  console.error('Invalid:', result.invalidReason);
}
```

### Create Voucher for Signing

```typescript
import {
  generateVoucherId,
  createVoucherMessage,
  createEIP712Domain,
  VOUCHER_TYPES
} from '@perkos/scheme-deferred';
import { signTypedData } from 'viem/accounts';

// Generate unique voucher ID
const voucherId = generateVoucherId();

// Create voucher message
const message = createVoucherMessage(
  voucherId,
  '0x...buyer',        // buyer
  '0x...seller',       // seller
  '5000000',           // valueAggregate
  '0x...usdc',         // asset
  Math.floor(Date.now() / 1000), // timestamp
  '1',                 // nonce
  '0x...escrow',       // escrow
  8453                 // chainId
);

// Create EIP-712 domain
const domain = createEIP712Domain(
  8453,                // chainId
  '0x...escrow'        // escrow contract address
);

// Sign the voucher (client-side)
const signature = await signTypedData({
  domain,
  types: VOUCHER_TYPES,
  primaryType: 'Voucher',
  message,
  privateKey: '0x...'
});
```

### Check Escrow Balance

```typescript
const verifier = new DeferredSchemeVerifier({
  network: 'base',
  escrowAddress: '0x...'
});

const balance = await verifier.getEscrowBalance(
  '0x...buyer',
  '0x...seller',
  '0x...asset'
);

console.log('Available balance:', balance.toString());
```

### Check Voucher Status

```typescript
const claimed = await verifier.isVoucherClaimed(
  '0x...voucherId',
  1n // nonce
);

if (claimed) {
  console.log('Voucher already claimed');
}
```

### Recover Signer from Voucher

```typescript
const signer = await verifier.recoverSigner(voucher, signature);

if (signer && signer.toLowerCase() === voucher.buyer.toLowerCase()) {
  console.log('Valid signature from buyer');
}
```

## API Reference

### DeferredSchemeVerifier

```typescript
class DeferredSchemeVerifier {
  constructor(config: DeferredSchemeConfig);

  // Verification
  verify(payload: DeferredPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  validateVoucher(voucher: Voucher, requirements: PaymentRequirements): boolean;
  recoverSigner(voucher: Voucher, signature: Hex): Promise<Address | null>;

  // Escrow operations
  getEscrowBalance(buyer: Address, seller: Address, asset: Address): Promise<bigint>;
  isVoucherClaimed(voucherId: Hex, nonce: bigint): Promise<boolean>;

  // Getters
  getNetwork(): SupportedNetwork;
  getChainId(): number;
  getEscrowAddress(): Address;
  getEIP712Domain(): EIP712Domain;
}
```

### DeferredSchemeConfig

```typescript
interface DeferredSchemeConfig {
  network: SupportedNetwork;
  escrowAddress: Address;
  rpcUrl?: string;
  domainName?: string;      // default: "X402DeferredEscrow"
  domainVersion?: string;   // default: "1"
}
```

### EIP712Domain

```typescript
interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}
```

### SignatureParts

```typescript
interface SignatureParts {
  v: number;
  r: Hex;
  s: Hex;
}
```

## Utility Functions

### generateVoucherId

Generate a random bytes32 voucher ID.

```typescript
import { generateVoucherId } from '@perkos/scheme-deferred';

const voucherId = generateVoucherId();
// => '0x1234...abcd' (32 bytes hex)
```

### createVoucherMessage

Create a voucher message object for EIP-712 signing.

```typescript
import { createVoucherMessage } from '@perkos/scheme-deferred';

const message = createVoucherMessage(
  '0x...',      // id
  '0x...',      // buyer
  '0x...',      // seller
  '5000000',    // valueAggregate
  '0x...',      // asset
  1735689600,   // timestamp
  '1',          // nonce
  '0x...',      // escrow
  8453          // chainId
);
```

### createVoucherTuple

Convert a Voucher object to a tuple format for contract calls.

```typescript
import { createVoucherTuple } from '@perkos/scheme-deferred';

const tuple = createVoucherTuple(voucher);
// Use with escrow contract claimVoucher function
```

### createEIP712Domain

Create an EIP-712 domain for voucher signing.

```typescript
import { createEIP712Domain } from '@perkos/scheme-deferred';

const domain = createEIP712Domain(
  8453,           // chainId
  '0x...',        // escrowAddress
  'CustomName',   // optional domain name
  '2'             // optional version
);
```

### parseSignature

Parse a signature into v, r, s components.

```typescript
import { parseSignature } from '@perkos/scheme-deferred';

const { v, r, s } = parseSignature('0x...');
```

## EIP-712 Type Definition

The voucher type definition used for EIP-712 signing:

```typescript
import { VOUCHER_TYPES, VOUCHER_TYPE_DEF } from '@perkos/scheme-deferred';

// VOUCHER_TYPE_DEF structure:
[
  { name: "id", type: "bytes32" },
  { name: "buyer", type: "address" },
  { name: "seller", type: "address" },
  { name: "valueAggregate", type: "uint256" },
  { name: "asset", type: "address" },
  { name: "timestamp", type: "uint64" },
  { name: "nonce", type: "uint256" },
  { name: "escrow", type: "address" },
  { name: "chainId", type: "uint256" }
]
```

## Escrow Contract ABIs

The package exports ABIs for interacting with the deferred escrow contract:

```typescript
import {
  DEFERRED_ESCROW_ABI,
  DEFERRED_ESCROW_GET_BALANCE_ABI,
  DEFERRED_ESCROW_VOUCHER_CLAIMED_ABI,
  DEFERRED_ESCROW_CLAIM_VOUCHER_ABI,
  ERC20_BALANCE_ABI
} from '@perkos/scheme-deferred';
```

### Available Functions

| ABI | Function | Description |
|-----|----------|-------------|
| `DEFERRED_ESCROW_GET_BALANCE_ABI` | `getAvailableBalance(buyer, seller, asset)` | Get escrow balance |
| `DEFERRED_ESCROW_VOUCHER_CLAIMED_ABI` | `voucherClaimed(voucherId, nonce)` | Check if claimed |
| `DEFERRED_ESCROW_CLAIM_VOUCHER_ABI` | `claimVoucher(voucher, signature)` | Claim voucher |

## Verification Flow

The `verify()` method performs these checks in order:

1. **Voucher Validation**: Checks escrow address, chainId, seller, amount, and asset
2. **Signature Recovery**: Recovers signer using EIP-712 typed data
3. **Signer Verification**: Ensures signer matches voucher buyer
4. **Claim Status**: Checks if voucher already claimed on-chain
5. **Balance Check**: Verifies sufficient escrow balance

## Re-exported Types

```typescript
import type {
  DeferredPayload,
  Voucher,
  VerifyResponse,
  PaymentRequirements,
  Address,
  Hex
} from '@perkos/scheme-deferred';

// V2 helper
import { getPaymentAmount } from '@perkos/scheme-deferred';
```

## Related Packages

- [@perkos/types-x402](https://www.npmjs.com/package/@perkos/types-x402) - Core x402 types
- [@perkos/util-chains](https://www.npmjs.com/package/@perkos/util-chains) - Chain utilities
- [@perkos/scheme-exact](https://www.npmjs.com/package/@perkos/scheme-exact) - Exact payment scheme
- [@perkos/contracts-escrow](https://www.npmjs.com/package/@perkos/contracts-escrow) - Escrow contract ABI
- [@perkos/service-x402](https://www.npmjs.com/package/@perkos/service-x402) - x402 service orchestrator

## License

MIT
