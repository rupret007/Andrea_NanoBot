import crypto from 'crypto';

import {
  AmazonBusinessClient,
  AmazonBusinessOrderMode,
  AmazonBusinessSearchItem,
  formatAmazonBusinessStatusMessage,
  getAmazonBusinessStatus,
  resolveAmazonBusinessConfig,
} from './amazon-business.js';
import {
  createPurchaseRequest,
  getPurchaseRequestById,
  listPurchaseRequestsForGroup,
  PurchaseRequestRecord,
  updatePurchaseRequest,
} from './db.js';
import { readEnvFile } from './env.js';
import { assertValidGroupFolder } from './group-folder.js';

const SHOPPING_ENV_KEYS = ['AMAZON_PURCHASE_APPROVAL_TTL_MINUTES'] as const;
const DEFAULT_APPROVAL_TTL_MINUTES = 30;
const APPROVAL_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type AmazonPurchaseRequestStatus =
  | 'pending_approval'
  | 'submitted'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'failed';

export interface CreateAmazonPurchaseRequestInput {
  groupFolder: string;
  chatJid: string;
  requestedBy?: string;
  asin: string;
  offerId: string;
  quantity?: number;
  title?: string;
  productUrl?: string;
}

export interface CreatedAmazonPurchaseRequest {
  record: PurchaseRequestRecord;
  approvalCode: string;
  message: string;
}

export interface ApproveAmazonPurchaseRequestInput {
  groupFolder: string;
  requestId: string;
  approvalCode: string;
  approvedBy?: string;
}

export interface ApprovedAmazonPurchaseRequest {
  record: PurchaseRequestRecord;
  message: string;
}

export interface CancelAmazonPurchaseRequestInput {
  groupFolder: string;
  requestId: string;
}

export interface CancelledAmazonPurchaseRequest {
  record: PurchaseRequestRecord;
  message: string;
}

function normalizeApprovalTtlMinutes(raw: string | undefined): number {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_APPROVAL_TTL_MINUTES;
  }
  return parsed;
}

function getApprovalTtlMinutes(): number {
  const envFile = readEnvFile([...SHOPPING_ENV_KEYS]);
  return normalizeApprovalTtlMinutes(
    process.env.AMAZON_PURCHASE_APPROVAL_TTL_MINUTES ||
      envFile.AMAZON_PURCHASE_APPROVAL_TTL_MINUTES,
  );
}

function generateApprovalCode(length = 8): string {
  let code = '';
  while (code.length < length) {
    const byte = crypto.randomBytes(1)[0] ?? 0;
    code += APPROVAL_CODE_CHARSET[byte % APPROVAL_CODE_CHARSET.length];
  }
  return code;
}

function hashApprovalCode(requestId: string, code: string): string {
  return crypto
    .createHash('sha256')
    .update(`${requestId}:${code}`, 'utf8')
    .digest('hex');
}

function timingSafeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function assertAmazonSearchReady(): AmazonBusinessClient {
  const config = resolveAmazonBusinessConfig();
  if (!config) {
    throw new Error(
      formatAmazonBusinessStatusMessage(getAmazonBusinessStatus()),
    );
  }
  return new AmazonBusinessClient(config);
}

function assertAmazonOrderReady(): AmazonBusinessClient {
  const config = resolveAmazonBusinessConfig();
  if (!config || !config.shippingAddress) {
    throw new Error(
      formatAmazonBusinessStatusMessage(getAmazonBusinessStatus()),
    );
  }
  return new AmazonBusinessClient(config);
}

function formatPrice(
  currencyCode: string | null,
  amount: number | null,
): string | null {
  if (!currencyCode || amount === null || !Number.isFinite(amount)) return null;
  return `${currencyCode} ${amount.toFixed(2)}`;
}

function formatExpiration(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function createPurchaseRequestId(now: Date): string {
  return `purchase-${now.getTime().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function toMinorUnits(amount: number | null): number | null {
  if (amount === null || !Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

function ensurePendingApproval(record: PurchaseRequestRecord): void {
  if (record.status !== 'pending_approval') {
    throw new Error('That purchase request is no longer waiting for approval.');
  }
}

function markExpiredIfNeeded(
  record: PurchaseRequestRecord,
): PurchaseRequestRecord {
  const expiresAt = new Date(record.approval_expires_at).getTime();
  if (record.status !== 'pending_approval' || Number.isNaN(expiresAt)) {
    return record;
  }

  if (expiresAt > Date.now()) return record;

  updatePurchaseRequest(record.id, {
    status: 'expired',
    failure_reason: 'Approval window expired before confirmation.',
    updated_at: new Date().toISOString(),
  });

  return {
    ...record,
    status: 'expired',
    failure_reason: 'Approval window expired before confirmation.',
    updated_at: new Date().toISOString(),
  };
}

function buildPurchaseRequestMessage(
  record: PurchaseRequestRecord,
  approvalCode: string,
): string {
  const total =
    record.expected_total_price ?? record.expected_unit_price ?? null;
  const priceText = formatPrice(record.currency_code, total);

  return [
    `Purchase request ${record.id} is ready for approval.`,
    `${record.product_title} x${record.quantity}`,
    priceText ? `Expected total: ${priceText}` : null,
    `Mode: ${record.order_mode}`,
    `Approval code: ${approvalCode}`,
    `Approve with \`/purchase-approve ${record.id} ${approvalCode}\` before ${formatExpiration(record.approval_expires_at)}.`,
    'Andrea will not submit the order without that code. Very obedient. Slightly dramatic. But obedient.',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function buildApprovalResultMessage(
  record: PurchaseRequestRecord,
  orderMode: AmazonBusinessOrderMode,
): string {
  if (orderMode === 'trial') {
    return [
      `Trial purchase check passed for ${record.product_title}.`,
      'No real order was submitted because trial mode is enabled.',
      `Request ${record.id} is now marked completed.`,
    ].join('\n');
  }

  return [
    `Purchase submitted for ${record.product_title}.`,
    record.submitted_order_id
      ? `Amazon order id: ${record.submitted_order_id}`
      : `Request id: ${record.id}`,
  ].join('\n');
}

export function formatAmazonSearchResultsMessage(
  query: string,
  results: AmazonBusinessSearchItem[],
): string {
  if (results.length === 0) {
    return `I couldn't find any Amazon Business results for "${query}" right now.`;
  }

  const lines = results.map((item, index) => {
    const priceText = formatPrice(
      item.offer?.price.currencyCode || null,
      item.offer?.price.amount || null,
    );
    return [
      `${index + 1}. ${item.title}`,
      `ASIN: ${item.asin}`,
      item.offer?.offerId
        ? `Offer: ${item.offer.offerId}`
        : 'Offer: unavailable',
      priceText ? `Price: ${priceText}` : null,
      item.offer?.merchantName ? `Seller: ${item.offer.merchantName}` : null,
      item.offer?.availability
        ? `Availability: ${item.offer.availability}`
        : null,
      item.productUrl ? `URL: ${item.productUrl}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  });

  return [
    `Amazon Business results for "${query}":`,
    '',
    lines.join('\n\n'),
    '',
    'Use `/purchase-request <asin> <offer_id> [quantity]` if you want Andrea to prepare an approval request.',
  ].join('\n');
}

export function formatAmazonPurchaseRequestsMessage(
  records: PurchaseRequestRecord[],
): string {
  if (records.length === 0) {
    return 'There are no tracked Amazon purchase requests for this chat yet.';
  }

  return [
    'Amazon purchase requests:',
    '',
    records
      .map((record, index) => {
        const total =
          record.expected_total_price ?? record.expected_unit_price ?? null;
        const priceText = formatPrice(record.currency_code, total);
        return [
          `${index + 1}. ${record.id} [${record.status}]`,
          `${record.product_title} x${record.quantity}`,
          priceText ? `Expected total: ${priceText}` : null,
          `Expires: ${formatExpiration(record.approval_expires_at)}`,
          record.failure_reason ? `Note: ${record.failure_reason}` : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n');
      })
      .join('\n\n'),
  ].join('\n');
}

export async function searchAmazonProducts(
  query: string,
  limit = 5,
): Promise<AmazonBusinessSearchItem[]> {
  const client = assertAmazonSearchReady();
  const result = await client.searchProducts({ query, limit });
  return result.items;
}

export async function createAmazonPurchaseRequest(
  input: CreateAmazonPurchaseRequestInput,
): Promise<CreatedAmazonPurchaseRequest> {
  assertValidGroupFolder(input.groupFolder);
  const client = assertAmazonOrderReady();
  const quantity = Math.max(1, Math.min(999, Math.floor(input.quantity || 1)));
  const offers = await client.getOffers({
    asin: input.asin,
    quantity,
    pageSize: 10,
  });
  const offer = offers.find((entry) => entry.offerId === input.offerId);
  if (!offer) {
    throw new Error(
      `I couldn't confirm offer ${input.offerId} for ASIN ${input.asin}. Run a fresh Amazon search and try again.`,
    );
  }
  if (
    offer.buyingGuidance === 'BLOCKED' ||
    offer.buyingGuidance === 'RESTRICTED'
  ) {
    throw new Error(
      `Amazon marked that offer as ${offer.buyingGuidance.toLowerCase()} for this account, so I won't prepare a purchase request for it.`,
    );
  }

  const now = new Date();
  const ttlMinutes = getApprovalTtlMinutes();
  const approvalExpiresAt = new Date(
    now.getTime() + ttlMinutes * 60 * 1000,
  ).toISOString();
  const requestId = createPurchaseRequestId(now);
  const approvalCode = generateApprovalCode();
  const expectedUnitPrice = offer.price.amount;
  const expectedTotalPrice =
    expectedUnitPrice === null ? null : expectedUnitPrice * quantity;

  const record: PurchaseRequestRecord = {
    id: requestId,
    group_folder: input.groupFolder,
    chat_jid: input.chatJid,
    requested_by: input.requestedBy || null,
    provider: 'amazon-business',
    status: 'pending_approval',
    product_title: input.title?.trim() || input.asin,
    product_url: input.productUrl?.trim() || null,
    asin: input.asin,
    offer_id: input.offerId,
    quantity,
    merchant_name: offer.merchantName,
    availability: offer.availability,
    buying_guidance: offer.buyingGuidance,
    currency_code: offer.price.currencyCode,
    expected_unit_price: expectedUnitPrice,
    expected_total_price: expectedTotalPrice,
    approval_code_hash: hashApprovalCode(requestId, approvalCode),
    approval_expires_at: approvalExpiresAt,
    approved_by: null,
    approved_at: null,
    order_mode: resolveAmazonBusinessConfig()?.orderMode || 'trial',
    external_order_id: requestId,
    submitted_order_id: null,
    submitted_at: null,
    completed_at: null,
    cancelled_at: null,
    failure_reason: null,
    raw_json: JSON.stringify({
      offer,
      source: 'andrea-amazon-request',
    }),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  createPurchaseRequest(record);

  return {
    record,
    approvalCode,
    message: buildPurchaseRequestMessage(record, approvalCode),
  };
}

export function listAmazonPurchaseRequests(
  groupFolder: string,
  limit = 20,
): PurchaseRequestRecord[] {
  assertValidGroupFolder(groupFolder);
  return listPurchaseRequestsForGroup(groupFolder, limit).map((record) =>
    markExpiredIfNeeded(record),
  );
}

export async function approveAmazonPurchaseRequest(
  input: ApproveAmazonPurchaseRequestInput,
): Promise<ApprovedAmazonPurchaseRequest> {
  assertValidGroupFolder(input.groupFolder);
  const client = assertAmazonOrderReady();
  const existing = getPurchaseRequestById(input.requestId);
  if (!existing || existing.group_folder !== input.groupFolder) {
    throw new Error(
      `No purchase request with id "${input.requestId}" exists for this chat.`,
    );
  }

  const record = markExpiredIfNeeded(existing);
  ensurePendingApproval(record);

  const expectedHash = hashApprovalCode(
    record.id,
    input.approvalCode.trim().toUpperCase(),
  );
  if (!timingSafeEquals(record.approval_code_hash, expectedHash)) {
    throw new Error(
      'That approval code does not match the stored purchase request.',
    );
  }

  const offers = await client.getOffers({
    asin: record.asin,
    quantity: record.quantity,
    pageSize: 10,
  });
  const offer = offers.find((entry) => entry.offerId === record.offer_id);
  if (!offer) {
    updatePurchaseRequest(record.id, {
      status: 'failed',
      failure_reason: 'Offer was no longer available at approval time.',
      updated_at: new Date().toISOString(),
    });
    throw new Error(
      'That offer is no longer available. Run a fresh Amazon search so I can prepare a new approval request.',
    );
  }
  if (
    toMinorUnits(record.expected_unit_price) !== null &&
    toMinorUnits(offer.price.amount) !== null &&
    toMinorUnits(offer.price.amount) !==
      toMinorUnits(record.expected_unit_price)
  ) {
    updatePurchaseRequest(record.id, {
      status: 'failed',
      failure_reason: 'Offer price changed before approval.',
      updated_at: new Date().toISOString(),
    });
    throw new Error(
      'The price changed after approval was requested, so I blocked the purchase. Run a fresh Amazon search and approve the new amount instead.',
    );
  }

  const approvedAt = new Date().toISOString();
  updatePurchaseRequest(record.id, {
    status: 'submitted',
    approved_by: input.approvedBy || null,
    approved_at: approvedAt,
    submitted_at: approvedAt,
    updated_at: approvedAt,
  });

  try {
    const orderResult = await client.placeOrder({
      externalId: record.external_order_id || record.id,
      asin: record.asin,
      offerId: record.offer_id,
      quantity: record.quantity,
    });
    const completedAt = new Date().toISOString();
    updatePurchaseRequest(record.id, {
      status: 'completed',
      approved_by: input.approvedBy || null,
      approved_at: approvedAt,
      submitted_at: approvedAt,
      submitted_order_id: orderResult.submittedOrderId,
      completed_at: completedAt,
      raw_json: JSON.stringify(orderResult.raw),
      updated_at: completedAt,
    });

    const updated: PurchaseRequestRecord = {
      ...record,
      status: 'completed',
      approved_by: input.approvedBy || null,
      approved_at: approvedAt,
      submitted_at: approvedAt,
      submitted_order_id: orderResult.submittedOrderId,
      completed_at: completedAt,
      raw_json: JSON.stringify(orderResult.raw),
      updated_at: completedAt,
    };

    return {
      record: updated,
      message: buildApprovalResultMessage(
        updated,
        (record.order_mode as AmazonBusinessOrderMode) || 'trial',
      ),
    };
  } catch (err) {
    updatePurchaseRequest(record.id, {
      status: 'failed',
      failure_reason: err instanceof Error ? err.message : String(err),
      updated_at: new Date().toISOString(),
    });
    throw err;
  }
}

export function cancelAmazonPurchaseRequest(
  input: CancelAmazonPurchaseRequestInput,
): CancelledAmazonPurchaseRequest {
  assertValidGroupFolder(input.groupFolder);
  const existing = getPurchaseRequestById(input.requestId);
  if (!existing || existing.group_folder !== input.groupFolder) {
    throw new Error(
      `No purchase request with id "${input.requestId}" exists for this chat.`,
    );
  }

  if (existing.status === 'cancelled') {
    return {
      record: existing,
      message: `Amazon purchase request ${existing.id} was already cancelled.`,
    };
  }

  if (existing.status === 'completed') {
    throw new Error(
      'That purchase request is already completed and can no longer be cancelled here.',
    );
  }

  const cancelledAt = new Date().toISOString();
  updatePurchaseRequest(existing.id, {
    status: 'cancelled',
    cancelled_at: cancelledAt,
    updated_at: cancelledAt,
  });

  return {
    record: {
      ...existing,
      status: 'cancelled',
      cancelled_at: cancelledAt,
      updated_at: cancelledAt,
    },
    message: `Cancelled Amazon purchase request ${existing.id}. No order will be submitted from this request.`,
  };
}
