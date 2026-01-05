/**
 * @perkos/scheme-deferred
 * EIP-712 Voucher-based deferred payment verification utilities for x402 deferred scheme
 */

import {
  createPublicClient,
  http,
  recoverTypedDataAddress,
  type PublicClient,
} from "viem";
import type {
  DeferredPayload,
  Voucher,
  VerifyResponse,
  PaymentRequirements,
  Address,
  Hex,
} from "@perkos/types-x402";
import {
  getChainById,
  getChainIdFromNetwork,
  getRpcUrl,
  type SupportedNetwork,
} from "@perkos/util-chains";

// ============ EIP-712 Types ============

export const VOUCHER_TYPE_DEF = [
  { name: "id", type: "bytes32" },
  { name: "buyer", type: "address" },
  { name: "seller", type: "address" },
  { name: "valueAggregate", type: "uint256" },
  { name: "asset", type: "address" },
  { name: "timestamp", type: "uint64" },
  { name: "nonce", type: "uint256" },
  { name: "escrow", type: "address" },
  { name: "chainId", type: "uint256" },
] as const;

export type VoucherTypes = {
  Voucher: typeof VOUCHER_TYPE_DEF;
};

export const VOUCHER_TYPES = {
  Voucher: VOUCHER_TYPE_DEF,
} as const;

export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export interface SignatureParts {
  v: number;
  r: Hex;
  s: Hex;
}

export interface DeferredSchemeConfig {
  network: SupportedNetwork;
  escrowAddress: Address;
  rpcUrl?: string;
  domainName?: string;
  domainVersion?: string;
}

export interface VerificationResult {
  isValid: boolean;
  invalidReason: string | null;
  payer: Address | null;
  recoveredSigner?: Address | null;
}

// ============ ERC-20 ABIs ============

export const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ============ Deferred Escrow ABIs ============

export const DEFERRED_ESCROW_GET_BALANCE_ABI = [
  {
    name: "getAvailableBalance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "asset", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const DEFERRED_ESCROW_VOUCHER_CLAIMED_ABI = [
  {
    name: "voucherClaimed",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "voucherId", type: "bytes32" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const DEFERRED_ESCROW_CLAIM_VOUCHER_ABI = [
  {
    name: "claimVoucher",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "voucher",
        type: "tuple",
        components: [
          { name: "id", type: "bytes32" },
          { name: "buyer", type: "address" },
          { name: "seller", type: "address" },
          { name: "valueAggregate", type: "uint256" },
          { name: "asset", type: "address" },
          { name: "timestamp", type: "uint64" },
          { name: "nonce", type: "uint256" },
          { name: "escrow", type: "address" },
          { name: "chainId", type: "uint256" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

// Combined ABI for escrow contract
export const DEFERRED_ESCROW_ABI = [
  ...DEFERRED_ESCROW_GET_BALANCE_ABI,
  ...DEFERRED_ESCROW_VOUCHER_CLAIMED_ABI,
  ...DEFERRED_ESCROW_CLAIM_VOUCHER_ABI,
] as const;

// ============ DeferredSchemeVerifier Class ============

export class DeferredSchemeVerifier {
  private network: SupportedNetwork;
  private chainId: number;
  private publicClient: PublicClient;
  private escrowAddress: Address;
  private domainName: string;
  private domainVersion: string;

  constructor(config: DeferredSchemeConfig) {
    this.network = config.network;
    this.chainId = getChainIdFromNetwork(config.network) || 1;
    this.escrowAddress = config.escrowAddress;
    this.domainName = config.domainName || "X402DeferredEscrow";
    this.domainVersion = config.domainVersion || "1";

    const chain = getChainById(this.chainId);
    const rpcUrl = config.rpcUrl || getRpcUrl(this.chainId);

    if (!chain || !rpcUrl) {
      throw new Error(`Unsupported network: ${config.network}`);
    }

    this.publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });
  }

  /**
   * Verify a deferred scheme payment voucher
   */
  async verify(
    payload: DeferredPayload,
    requirements: PaymentRequirements
  ): Promise<VerifyResponse> {
    try {
      const { voucher, signature } = payload;

      // 1. Validate voucher fields
      if (!this.validateVoucher(voucher, requirements)) {
        return {
          isValid: false,
          invalidReason: "Voucher fields invalid",
          payer: null,
        };
      }

      // 2. Verify signature and recover signer
      const signer = await this.recoverSigner(voucher, signature as Hex);

      if (!signer) {
        return {
          isValid: false,
          invalidReason: "Invalid signature",
          payer: null,
        };
      }

      // 3. Verify signer matches buyer
      if (signer.toLowerCase() !== voucher.buyer.toLowerCase()) {
        return {
          isValid: false,
          invalidReason: `Signer does not match buyer. Recovered: ${signer}, Expected: ${voucher.buyer}`,
          payer: null,
        };
      }

      // 4. Check if voucher already claimed
      const claimed = await this.isVoucherClaimed(
        voucher.id as Hex,
        BigInt(voucher.nonce)
      );

      if (claimed) {
        return {
          isValid: false,
          invalidReason: "Voucher already claimed",
          payer: null,
        };
      }

      // 5. Check escrow balance
      const balance = await this.getEscrowBalance(
        voucher.buyer,
        voucher.seller,
        voucher.asset
      );

      const valueAggregate = BigInt(voucher.valueAggregate);
      if (balance < valueAggregate) {
        return {
          isValid: false,
          invalidReason: "Insufficient escrow balance",
          payer: null,
        };
      }

      return {
        isValid: true,
        invalidReason: null,
        payer: voucher.buyer,
      };
    } catch (error) {
      return {
        isValid: false,
        invalidReason: error instanceof Error ? error.message : "Verification failed",
        payer: null,
      };
    }
  }

  /**
   * Validate voucher fields against requirements
   */
  validateVoucher(
    voucher: Voucher,
    requirements: PaymentRequirements
  ): boolean {
    // Validate escrow address
    if (voucher.escrow.toLowerCase() !== this.escrowAddress.toLowerCase()) {
      return false;
    }

    // Validate chain ID
    if (BigInt(voucher.chainId) !== BigInt(this.chainId)) {
      return false;
    }

    // Validate seller (payTo)
    if (voucher.seller.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return false;
    }

    // Validate amount (should not exceed max)
    const valueAggregate = BigInt(voucher.valueAggregate);
    const maxAmount = BigInt(requirements.maxAmountRequired);
    if (valueAggregate > maxAmount) {
      return false;
    }

    // Validate asset
    if (voucher.asset.toLowerCase() !== requirements.asset.toLowerCase()) {
      return false;
    }

    return true;
  }

  /**
   * Recover signer from EIP-712 typed data signature
   */
  async recoverSigner(voucher: Voucher, signature: Hex): Promise<Address | null> {
    try {
      const domain = this.getEIP712Domain();

      const message = {
        id: voucher.id,
        buyer: voucher.buyer,
        seller: voucher.seller,
        valueAggregate: BigInt(voucher.valueAggregate),
        asset: voucher.asset,
        timestamp: BigInt(voucher.timestamp),
        nonce: BigInt(voucher.nonce),
        escrow: voucher.escrow,
        chainId: BigInt(voucher.chainId),
      };

      const recoveredAddress = await recoverTypedDataAddress({
        domain,
        types: VOUCHER_TYPES,
        primaryType: "Voucher",
        message,
        signature,
      });

      return recoveredAddress as Address;
    } catch {
      return null;
    }
  }

  /**
   * Get EIP-712 domain for escrow contract
   */
  getEIP712Domain(): EIP712Domain {
    return {
      name: this.domainName,
      version: this.domainVersion,
      chainId: this.chainId,
      verifyingContract: this.escrowAddress,
    };
  }

  /**
   * Check if voucher has been claimed
   */
  async isVoucherClaimed(voucherId: Hex, nonce: bigint): Promise<boolean> {
    try {
      const claimed = await this.publicClient.readContract({
        address: this.escrowAddress,
        abi: DEFERRED_ESCROW_VOUCHER_CLAIMED_ABI,
        functionName: "voucherClaimed",
        args: [voucherId, nonce],
      });

      return claimed as boolean;
    } catch {
      // Contract may not exist or different ABI
      return false;
    }
  }

  /**
   * Get available escrow balance
   */
  async getEscrowBalance(
    buyer: Address,
    seller: Address,
    asset: Address
  ): Promise<bigint> {
    try {
      const balance = await this.publicClient.readContract({
        address: this.escrowAddress,
        abi: DEFERRED_ESCROW_GET_BALANCE_ABI,
        functionName: "getAvailableBalance",
        args: [buyer, seller, asset],
      });

      return balance as bigint;
    } catch {
      return 0n;
    }
  }

  /**
   * Get network name
   */
  getNetwork(): SupportedNetwork {
    return this.network;
  }

  /**
   * Get chain ID
   */
  getChainId(): number {
    return this.chainId;
  }

  /**
   * Get escrow address
   */
  getEscrowAddress(): Address {
    return this.escrowAddress;
  }
}

// ============ Utility Functions ============

/**
 * Parse signature into v, r, s components
 */
export function parseSignature(signature: Hex): SignatureParts {
  const sig = signature.slice(2); // Remove '0x'
  const r = `0x${sig.slice(0, 64)}` as Hex;
  const s = `0x${sig.slice(64, 128)}` as Hex;
  const v = parseInt(sig.slice(128, 130), 16);

  return { v, r, s };
}

/**
 * Create EIP-712 domain for deferred escrow
 */
export function createEIP712Domain(
  chainId: number,
  escrowAddress: Address,
  domainName?: string,
  domainVersion?: string
): EIP712Domain {
  return {
    name: domainName || "X402DeferredEscrow",
    version: domainVersion || "1",
    chainId,
    verifyingContract: escrowAddress,
  };
}

/**
 * Generate a random voucher ID (bytes32)
 */
export function generateVoucherId(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as Hex;
}

/**
 * Create voucher message for signing
 */
export function createVoucherMessage(
  id: Hex,
  buyer: Address,
  seller: Address,
  valueAggregate: bigint | string,
  asset: Address,
  timestamp: bigint | string,
  nonce: bigint | string,
  escrow: Address,
  chainId: number
) {
  return {
    id,
    buyer,
    seller,
    valueAggregate: BigInt(valueAggregate),
    asset,
    timestamp: BigInt(timestamp),
    nonce: BigInt(nonce),
    escrow,
    chainId: BigInt(chainId),
  };
}

/**
 * Create a voucher tuple for contract calls
 */
export function createVoucherTuple(voucher: Voucher) {
  return {
    id: voucher.id,
    buyer: voucher.buyer,
    seller: voucher.seller,
    valueAggregate: BigInt(voucher.valueAggregate),
    asset: voucher.asset,
    timestamp: BigInt(voucher.timestamp),
    nonce: BigInt(voucher.nonce),
    escrow: voucher.escrow,
    chainId: BigInt(voucher.chainId),
  };
}

// Re-export types
export type { DeferredPayload, Voucher, VerifyResponse, PaymentRequirements, Address, Hex };
