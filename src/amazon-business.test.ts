import { describe, expect, it } from 'vitest';

import {
  AmazonBusinessClient,
  buildAmazonBusinessOrderPayload,
  getAmazonBusinessStatus,
  resolveAmazonBusinessRegion,
} from './amazon-business.js';

const TEST_CONFIG = {
  baseUrl: 'https://na.business-api.amazon.com',
  region: 'us-east-1',
  lwaClientId: 'lwa-client',
  lwaClientSecret: 'lwa-secret',
  lwaRefreshToken: 'lwa-refresh',
  awsAccessKeyId: 'aws-key',
  awsSecretAccessKey: 'aws-secret',
  awsSessionToken: null,
  userEmail: 'buyer@example.com',
  groupTag: 'eng',
  productRegion: 'US',
  locale: 'en_US',
  shippingPostalCode: '60601',
  orderMode: 'trial' as const,
  timeoutMs: 5000,
  shippingAddress: {
    fullName: 'Andrea Buyer',
    phoneNumber: '555-123-4567',
    addressLine1: '123 Main St',
    city: 'Chicago',
    stateOrRegion: 'IL',
    postalCode: '60601',
    countryCode: 'US',
  },
};

describe('amazon-business status and payload helpers', () => {
  it('detects ready search and order configuration from environment', () => {
    const status = getAmazonBusinessStatus({
      env: {
        AMAZON_BUSINESS_API_BASE_URL: 'https://na.business-api.amazon.com',
        AMAZON_BUSINESS_LWA_CLIENT_ID: 'lwa-client',
        AMAZON_BUSINESS_LWA_CLIENT_SECRET: 'lwa-secret',
        AMAZON_BUSINESS_LWA_REFRESH_TOKEN: 'lwa-refresh',
        AMAZON_BUSINESS_AWS_ACCESS_KEY_ID: 'aws-key',
        AMAZON_BUSINESS_AWS_SECRET_ACCESS_KEY: 'aws-secret',
        AMAZON_BUSINESS_USER_EMAIL: 'buyer@example.com',
        AMAZON_BUSINESS_GROUP_TAG: 'eng',
        AMAZON_BUSINESS_PRODUCT_REGION: 'US',
        AMAZON_BUSINESS_LOCALE: 'en_US',
        AMAZON_BUSINESS_ORDER_MODE: 'trial',
        AMAZON_BUSINESS_SHIPPING_FULL_NAME: 'Andrea Buyer',
        AMAZON_BUSINESS_SHIPPING_PHONE_NUMBER: '555-123-4567',
        AMAZON_BUSINESS_SHIPPING_ADDRESS_LINE1: '123 Main St',
        AMAZON_BUSINESS_SHIPPING_CITY: 'Chicago',
        AMAZON_BUSINESS_SHIPPING_STATE_OR_REGION: 'IL',
        AMAZON_BUSINESS_SHIPPING_POSTAL_CODE: '60601',
        AMAZON_BUSINESS_SHIPPING_COUNTRY_CODE: 'US',
      },
      envFileValues: {},
    });

    expect(status.searchReady).toBe(true);
    expect(status.orderReady).toBe(true);
    expect(status.region).toBe('us-east-1');
    expect(status.orderMode).toBe('trial');
  });

  it('infers Amazon Business region from endpoint hostname', () => {
    expect(
      resolveAmazonBusinessRegion('https://eu.business-api.amazon.com'),
    ).toBe('eu-west-1');
    expect(
      resolveAmazonBusinessRegion('https://jp.business-api.amazon.com'),
    ).toBe('us-west-2');
  });

  it('builds an order payload with product, buying option, address, and trial mode', () => {
    const payload = buildAmazonBusinessOrderPayload({
      externalId: 'purchase-123',
      asin: 'B012345678',
      offerId: 'offer-123',
      quantity: 2,
      shippingAddress: TEST_CONFIG.shippingAddress!,
      orderMode: 'trial',
    });

    const lineItem = (payload.lineItems as Array<Record<string, unknown>>)[0];
    const orderAttributes = payload.attributes as Array<
      Record<string, unknown>
    >;

    expect(lineItem.quantity).toBe(2);
    expect(lineItem.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributeType: 'SelectedProductReference',
        }),
        expect.objectContaining({
          attributeType: 'SelectedBuyingOptionReference',
        }),
      ]),
    );
    expect(orderAttributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributeType: 'ShippingAddress' }),
        expect.objectContaining({
          attributeType: 'SelectedPaymentMethodReference',
        }),
        expect.objectContaining({ attributeType: 'TrialMode' }),
      ]),
    );
  });
});

describe('AmazonBusinessClient', () => {
  it('searches products and enriches the first result with offers', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);

      if (url === 'https://api.amazon.com/auth/o2/token') {
        return new Response(
          JSON.stringify({
            access_token: 'lwa-access-token',
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }

      if (url.includes('/products/2020-08-26/products?')) {
        expect(init?.method).toBe('GET');
        expect(
          (init?.headers as Record<string, string>)['Authorization'],
        ).toContain('AWS4-HMAC-SHA256');
        expect(
          (init?.headers as Record<string, string>)['x-amz-user-email'],
        ).toBe('buyer@example.com');
        return new Response(
          JSON.stringify({
            products: [
              {
                asin: 'B012345678',
                title: 'Ergonomic Keyboard',
                url: 'https://amazon.example/items/B012345678',
                features: ['Split layout'],
              },
            ],
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
                    amount: 129.99,
                    currencyCode: 'USD',
                  },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch URL ${url}`);
    }) as unknown as typeof fetch;

    const client = new AmazonBusinessClient(TEST_CONFIG, {
      fetchImpl,
      now: () => new Date('2026-03-28T12:00:00.000Z'),
    });

    const result = await client.searchProducts({
      query: 'ergonomic keyboard',
      limit: 1,
    });

    expect(calls).toHaveLength(3);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('Ergonomic Keyboard');
    expect(result.items[0].offer?.offerId).toBe('offer-123');
    expect(result.items[0].offer?.price.amount).toBe(129.99);
  });

  it('places an order using the ordering API payload', async () => {
    let requestBody = '';

    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
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

      if (url.includes('/ordering/2022-10-30/orders')) {
        requestBody = String(init?.body || '');
        expect(init?.method).toBe('POST');
        expect(
          (init?.headers as Record<string, string>)['Authorization'],
        ).toContain('AWS4-HMAC-SHA256');
        return new Response(
          JSON.stringify({
            externalId: 'purchase-123',
            submittedOrderId: 'ABO-123',
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected fetch URL ${url}`);
    }) as unknown as typeof fetch;

    const client = new AmazonBusinessClient(TEST_CONFIG, {
      fetchImpl,
      now: () => new Date('2026-03-28T12:00:00.000Z'),
    });

    const result = await client.placeOrder({
      externalId: 'purchase-123',
      asin: 'B012345678',
      offerId: 'offer-123',
      quantity: 1,
    });

    const parsedBody = JSON.parse(requestBody) as Record<string, unknown>;
    const orderAttributes = parsedBody.attributes as Array<
      Record<string, unknown>
    >;

    expect(orderAttributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributeType: 'TrialMode' }),
      ]),
    );
    expect(result.externalId).toBe('purchase-123');
    expect(result.submittedOrderId).toBe('ABO-123');
  });
});
