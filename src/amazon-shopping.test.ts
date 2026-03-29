import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPurchaseRequest as createPurchaseRequestRecord,
  _initTestDatabase,
  getPurchaseRequestById,
  PurchaseRequestRecord,
} from './db.js';
import {
  approveAmazonPurchaseRequest,
  cancelAmazonPurchaseRequest,
  createAmazonPurchaseRequest,
  listAmazonPurchaseRequests,
} from './amazon-shopping.js';

const originalFetch = globalThis.fetch;

function setAmazonEnv(orderMode: 'trial' | 'live' = 'trial'): void {
  process.env.AMAZON_BUSINESS_API_BASE_URL =
    'https://na.business-api.amazon.com';
  process.env.AMAZON_BUSINESS_AWS_REGION = 'us-east-1';
  process.env.AMAZON_BUSINESS_LWA_CLIENT_ID = 'lwa-client';
  process.env.AMAZON_BUSINESS_LWA_CLIENT_SECRET = 'lwa-secret';
  process.env.AMAZON_BUSINESS_LWA_REFRESH_TOKEN = 'lwa-refresh';
  process.env.AMAZON_BUSINESS_AWS_ACCESS_KEY_ID = 'aws-key';
  process.env.AMAZON_BUSINESS_AWS_SECRET_ACCESS_KEY = 'aws-secret';
  process.env.AMAZON_BUSINESS_USER_EMAIL = 'buyer@example.com';
  process.env.AMAZON_BUSINESS_GROUP_TAG = 'eng';
  process.env.AMAZON_BUSINESS_PRODUCT_REGION = 'US';
  process.env.AMAZON_BUSINESS_LOCALE = 'en_US';
  process.env.AMAZON_BUSINESS_ORDER_MODE = orderMode;
  process.env.AMAZON_BUSINESS_SHIPPING_FULL_NAME = 'Andrea Buyer';
  process.env.AMAZON_BUSINESS_SHIPPING_PHONE_NUMBER = '555-123-4567';
  process.env.AMAZON_BUSINESS_SHIPPING_ADDRESS_LINE1 = '123 Main St';
  process.env.AMAZON_BUSINESS_SHIPPING_CITY = 'Chicago';
  process.env.AMAZON_BUSINESS_SHIPPING_STATE_OR_REGION = 'IL';
  process.env.AMAZON_BUSINESS_SHIPPING_POSTAL_CODE = '60601';
  process.env.AMAZON_BUSINESS_SHIPPING_COUNTRY_CODE = 'US';
  process.env.AMAZON_PURCHASE_APPROVAL_TTL_MINUTES = '30';
}

function clearAmazonEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AMAZON_')) {
      delete process.env[key];
    }
  }
}

function installAmazonFetchMock(currentPriceRef: { value: number }): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    if (url === 'https://api.amazon.com/auth/o2/token') {
      return new Response(
        JSON.stringify({
          access_token: 'lwa-access-token',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }

    if (url.includes('/products/2020-08-26/products/B012345678/offers?')) {
      return new Response(
        JSON.stringify({
          offers: [
            {
              offerId: 'offer-123',
              availability: 'IN_STOCK',
              merchant: { name: 'Acme Seller' },
              price: {
                value: {
                  amount: currentPriceRef.value,
                  currencyCode: 'USD',
                },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (url.includes('/ordering/2022-10-30/orders')) {
      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({
          externalId: 'purchase-order',
          submittedOrderId: null,
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected fetch URL ${url}`);
  }) as unknown as typeof fetch;
}

describe('amazon shopping approval flow', () => {
  beforeEach(() => {
    _initTestDatabase();
    setAmazonEnv('trial');
  });

  afterEach(() => {
    clearAmazonEnv();
    globalThis.fetch = originalFetch;
  });

  it('creates a purchase request and stores a hashed approval code', async () => {
    installAmazonFetchMock({ value: 129.99 });

    const created = await createAmazonPurchaseRequest({
      groupFolder: 'main',
      chatJid: 'tg:123',
      requestedBy: 'jeff',
      asin: 'B012345678',
      offerId: 'offer-123',
      quantity: 2,
      title: 'Ergonomic Keyboard',
      productUrl: 'https://amazon.example/items/B012345678',
    });

    expect(created.message).toContain('/purchase_approve');
    expect(created.message).toContain(created.approvalCode);

    const stored = getPurchaseRequestById(created.record.id);
    expect(stored).toBeDefined();
    expect(stored?.approval_code_hash).not.toContain(created.approvalCode);
    expect(stored?.status).toBe('pending_approval');
    expect(stored?.expected_total_price).toBe(259.98);
  });

  it('approves a request in trial mode and marks it completed', async () => {
    const currentPrice = { value: 129.99 };
    installAmazonFetchMock(currentPrice);

    const created = await createAmazonPurchaseRequest({
      groupFolder: 'main',
      chatJid: 'tg:123',
      asin: 'B012345678',
      offerId: 'offer-123',
      quantity: 1,
      title: 'Ergonomic Keyboard',
    });

    const approved = await approveAmazonPurchaseRequest({
      groupFolder: 'main',
      requestId: created.record.id,
      approvalCode: created.approvalCode,
      approvedBy: 'jeff',
    });

    expect(approved.message).toContain('Trial purchase check passed');
    expect(getPurchaseRequestById(created.record.id)?.status).toBe('completed');
  });

  it('blocks approval when the offer price changes', async () => {
    const currentPrice = { value: 129.99 };
    installAmazonFetchMock(currentPrice);

    const created = await createAmazonPurchaseRequest({
      groupFolder: 'main',
      chatJid: 'tg:123',
      asin: 'B012345678',
      offerId: 'offer-123',
      quantity: 1,
      title: 'Ergonomic Keyboard',
    });

    currentPrice.value = 149.99;

    await expect(
      approveAmazonPurchaseRequest({
        groupFolder: 'main',
        requestId: created.record.id,
        approvalCode: created.approvalCode,
      }),
    ).rejects.toThrow('price changed');

    expect(getPurchaseRequestById(created.record.id)?.status).toBe('failed');
  });

  it('rejects the wrong approval code', async () => {
    installAmazonFetchMock({ value: 129.99 });

    const created = await createAmazonPurchaseRequest({
      groupFolder: 'main',
      chatJid: 'tg:123',
      asin: 'B012345678',
      offerId: 'offer-123',
      quantity: 1,
    });

    await expect(
      approveAmazonPurchaseRequest({
        groupFolder: 'main',
        requestId: created.record.id,
        approvalCode: 'WRONG123',
      }),
    ).rejects.toThrow('approval code');
  });

  it('cancels a pending request and keeps repeated cancellation idempotent', async () => {
    installAmazonFetchMock({ value: 129.99 });

    const created = await createAmazonPurchaseRequest({
      groupFolder: 'main',
      chatJid: 'tg:123',
      asin: 'B012345678',
      offerId: 'offer-123',
      quantity: 1,
    });

    const cancelled = cancelAmazonPurchaseRequest({
      groupFolder: 'main',
      requestId: created.record.id,
    });
    const cancelledAgain = cancelAmazonPurchaseRequest({
      groupFolder: 'main',
      requestId: created.record.id,
    });

    expect(cancelled.message).toContain('Cancelled Amazon purchase request');
    expect(cancelledAgain.message).toContain('already cancelled');
    expect(getPurchaseRequestById(created.record.id)?.status).toBe('cancelled');
  });

  it('marks expired requests when listing them', () => {
    const staleRecord: PurchaseRequestRecord = {
      id: 'purchase-stale',
      group_folder: 'main',
      chat_jid: 'tg:123',
      requested_by: 'jeff',
      provider: 'amazon-business',
      status: 'pending_approval',
      product_title: 'Desk Lamp',
      product_url: null,
      asin: 'B000000001',
      offer_id: 'offer-stale',
      quantity: 1,
      merchant_name: 'Acme Seller',
      availability: 'IN_STOCK',
      buying_guidance: null,
      currency_code: 'USD',
      expected_unit_price: 19.99,
      expected_total_price: 19.99,
      approval_code_hash: 'hash',
      approval_expires_at: '2020-01-01T00:00:00.000Z',
      approved_by: null,
      approved_at: null,
      order_mode: 'trial',
      external_order_id: 'purchase-stale',
      submitted_order_id: null,
      submitted_at: null,
      completed_at: null,
      cancelled_at: null,
      failure_reason: null,
      raw_json: '{}',
      created_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
    };

    createPurchaseRequestRecord(staleRecord);

    const listed = listAmazonPurchaseRequests('main', 10);

    expect(listed[0].status).toBe('expired');
    expect(getPurchaseRequestById('purchase-stale')?.status).toBe('expired');
  });
});
