import crypto from 'crypto';

import { readEnvFile } from './env.js';

const AMAZON_BUSINESS_ENV_KEYS = [
  'AMAZON_BUSINESS_API_BASE_URL',
  'AMAZON_BUSINESS_AWS_REGION',
  'AMAZON_BUSINESS_LWA_CLIENT_ID',
  'AMAZON_BUSINESS_LWA_CLIENT_SECRET',
  'AMAZON_BUSINESS_LWA_REFRESH_TOKEN',
  'AMAZON_BUSINESS_AWS_ACCESS_KEY_ID',
  'AMAZON_BUSINESS_AWS_SECRET_ACCESS_KEY',
  'AMAZON_BUSINESS_AWS_SESSION_TOKEN',
  'AMAZON_BUSINESS_USER_EMAIL',
  'AMAZON_BUSINESS_GROUP_TAG',
  'AMAZON_BUSINESS_PRODUCT_REGION',
  'AMAZON_BUSINESS_LOCALE',
  'AMAZON_BUSINESS_SHIPPING_POSTAL_CODE',
  'AMAZON_BUSINESS_ORDER_MODE',
  'AMAZON_BUSINESS_TIMEOUT_MS',
  'AMAZON_BUSINESS_SHIPPING_FULL_NAME',
  'AMAZON_BUSINESS_SHIPPING_PHONE_NUMBER',
  'AMAZON_BUSINESS_SHIPPING_COMPANY_NAME',
  'AMAZON_BUSINESS_SHIPPING_ADDRESS_LINE1',
  'AMAZON_BUSINESS_SHIPPING_ADDRESS_LINE2',
  'AMAZON_BUSINESS_SHIPPING_CITY',
  'AMAZON_BUSINESS_SHIPPING_STATE_OR_REGION',
  'AMAZON_BUSINESS_SHIPPING_POSTAL_CODE',
  'AMAZON_BUSINESS_SHIPPING_COUNTRY_CODE',
] as const;

const AMAZON_LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const DEFAULT_AMAZON_BUSINESS_BASE_URL = 'https://na.business-api.amazon.com';
const DEFAULT_AMAZON_BUSINESS_REGION = 'us-east-1';
const DEFAULT_AMAZON_BUSINESS_PRODUCT_REGION = 'US';
const DEFAULT_AMAZON_BUSINESS_LOCALE = 'en_US';
const DEFAULT_AMAZON_BUSINESS_TIMEOUT_MS = 20_000;
const DEFAULT_AMAZON_BUSINESS_ORDER_MODE = 'trial';
const AMAZON_BUSINESS_SERVICE_NAME = 'execute-api';

const REGION_BY_HOSTNAME: Record<string, string> = {
  'na.business-api.amazon.com': 'us-east-1',
  'eu.business-api.amazon.com': 'eu-west-1',
  'jp.business-api.amazon.com': 'us-west-2',
};

export type AmazonBusinessOrderMode = 'trial' | 'live';

export interface AmazonBusinessShippingAddress {
  fullName: string;
  phoneNumber: string;
  companyName?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  stateOrRegion: string;
  postalCode: string;
  countryCode: string;
}

export interface AmazonBusinessConfig {
  baseUrl: string;
  region: string;
  lwaClientId: string;
  lwaClientSecret: string;
  lwaRefreshToken: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsSessionToken: string | null;
  userEmail: string;
  groupTag: string | null;
  productRegion: string;
  locale: string;
  shippingPostalCode: string | null;
  orderMode: AmazonBusinessOrderMode;
  timeoutMs: number;
  shippingAddress: AmazonBusinessShippingAddress | null;
}

export interface AmazonBusinessStatus {
  enabled: boolean;
  searchReady: boolean;
  orderReady: boolean;
  baseUrl: string;
  region: string;
  productRegion: string;
  locale: string;
  orderMode: AmazonBusinessOrderMode;
  hasLwaClientId: boolean;
  hasLwaClientSecret: boolean;
  hasLwaRefreshToken: boolean;
  hasAwsAccessKeyId: boolean;
  hasAwsSecretAccessKey: boolean;
  hasUserEmail: boolean;
  hasGroupTag: boolean;
  hasShippingAddress: boolean;
  hasShippingPostalCode: boolean;
  timeoutMs: number;
}

export interface AmazonBusinessStatusOptions {
  env?: Record<string, string | undefined>;
  envFileValues?: Record<string, string>;
}

export interface AmazonBusinessMoney {
  amount: number | null;
  currencyCode: string | null;
  formattedPrice: string | null;
}

export interface AmazonBusinessOffer {
  offerId: string;
  availability: string | null;
  buyingGuidance: string | null;
  merchantName: string | null;
  deliveryInformation: string | null;
  quantityLimit: number | null;
  price: AmazonBusinessMoney;
  raw: Record<string, unknown>;
}

export interface AmazonBusinessSearchItem {
  asin: string;
  title: string;
  productUrl: string | null;
  imageUrl: string | null;
  features: string[];
  offer: AmazonBusinessOffer | null;
  raw: Record<string, unknown>;
}

export interface AmazonBusinessSearchResponse {
  totalMatches: number | null;
  pageCount: number | null;
  items: AmazonBusinessSearchItem[];
  raw: unknown;
}

export interface AmazonBusinessOrderResult {
  externalId: string;
  submittedOrderId: string | null;
  raw: unknown;
}

export interface AmazonBusinessSearchProductsParams {
  query: string;
  limit?: number;
  pageNumber?: number;
  quantity?: number;
}

export interface AmazonBusinessGetOffersParams {
  asin: string;
  quantity?: number;
  pageSize?: number;
}

export interface BuildAmazonBusinessOrderPayloadParams {
  externalId: string;
  asin: string;
  offerId: string;
  quantity: number;
  shippingAddress: AmazonBusinessShippingAddress;
  orderMode: AmazonBusinessOrderMode;
}

export interface AmazonBusinessPlaceOrderParams {
  externalId: string;
  asin: string;
  offerId: string;
  quantity: number;
}

export class AmazonBusinessApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'AmazonBusinessApiError';
    this.status = status;
    this.body = body;
  }
}

function normalizeAmazonBusinessBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_AMAZON_BUSINESS_BASE_URL;
  return trimmed.replace(/\/+$/, '');
}

export function resolveAmazonBusinessRegion(
  baseUrl: string,
  explicitRegion?: string,
): string {
  const trimmedRegion = explicitRegion?.trim();
  if (trimmedRegion) return trimmedRegion;

  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return REGION_BY_HOSTNAME[hostname] || DEFAULT_AMAZON_BUSINESS_REGION;
  } catch {
    return DEFAULT_AMAZON_BUSINESS_REGION;
  }
}

function normalizeAmazonBusinessTimeoutMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AMAZON_BUSINESS_TIMEOUT_MS;
  }
  return parsed;
}

function normalizeAmazonBusinessOrderMode(
  value: string | undefined,
): AmazonBusinessOrderMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'live' ? 'live' : DEFAULT_AMAZON_BUSINESS_ORDER_MODE;
}

function uppercaseOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function resolveAmazonBusinessEnv(
  options: AmazonBusinessStatusOptions = {},
): Record<string, string | undefined> {
  const envFileValues =
    options.envFileValues ?? readEnvFile([...AMAZON_BUSINESS_ENV_KEYS]);
  const env = options.env ?? process.env;

  const resolved: Record<string, string | undefined> = {};
  for (const key of AMAZON_BUSINESS_ENV_KEYS) {
    resolved[key] = env[key] || envFileValues[key];
  }
  return resolved;
}

function resolveShippingAddress(
  env: Record<string, string | undefined>,
): AmazonBusinessShippingAddress | null {
  const required = {
    fullName: env.AMAZON_BUSINESS_SHIPPING_FULL_NAME?.trim(),
    phoneNumber: env.AMAZON_BUSINESS_SHIPPING_PHONE_NUMBER?.trim(),
    addressLine1: env.AMAZON_BUSINESS_SHIPPING_ADDRESS_LINE1?.trim(),
    city: env.AMAZON_BUSINESS_SHIPPING_CITY?.trim(),
    stateOrRegion: env.AMAZON_BUSINESS_SHIPPING_STATE_OR_REGION?.trim(),
    postalCode: env.AMAZON_BUSINESS_SHIPPING_POSTAL_CODE?.trim(),
    countryCode: uppercaseOrNull(env.AMAZON_BUSINESS_SHIPPING_COUNTRY_CODE),
  };

  if (
    !required.fullName ||
    !required.phoneNumber ||
    !required.addressLine1 ||
    !required.city ||
    !required.stateOrRegion ||
    !required.postalCode ||
    !required.countryCode
  ) {
    return null;
  }

  return {
    fullName: required.fullName,
    phoneNumber: required.phoneNumber,
    companyName: env.AMAZON_BUSINESS_SHIPPING_COMPANY_NAME?.trim() || undefined,
    addressLine1: required.addressLine1,
    addressLine2:
      env.AMAZON_BUSINESS_SHIPPING_ADDRESS_LINE2?.trim() || undefined,
    city: required.city,
    stateOrRegion: required.stateOrRegion,
    postalCode: required.postalCode,
    countryCode: required.countryCode,
  };
}

export function getAmazonBusinessStatus(
  options: AmazonBusinessStatusOptions = {},
): AmazonBusinessStatus {
  const resolved = resolveAmazonBusinessEnv(options);
  const baseUrl = normalizeAmazonBusinessBaseUrl(
    resolved.AMAZON_BUSINESS_API_BASE_URL,
  );
  const region = resolveAmazonBusinessRegion(
    baseUrl,
    resolved.AMAZON_BUSINESS_AWS_REGION,
  );
  const shippingAddress = resolveShippingAddress(resolved);

  const hasLwaClientId = Boolean(
    resolved.AMAZON_BUSINESS_LWA_CLIENT_ID?.trim(),
  );
  const hasLwaClientSecret = Boolean(
    resolved.AMAZON_BUSINESS_LWA_CLIENT_SECRET?.trim(),
  );
  const hasLwaRefreshToken = Boolean(
    resolved.AMAZON_BUSINESS_LWA_REFRESH_TOKEN?.trim(),
  );
  const hasAwsAccessKeyId = Boolean(
    resolved.AMAZON_BUSINESS_AWS_ACCESS_KEY_ID?.trim(),
  );
  const hasAwsSecretAccessKey = Boolean(
    resolved.AMAZON_BUSINESS_AWS_SECRET_ACCESS_KEY?.trim(),
  );
  const hasUserEmail = Boolean(resolved.AMAZON_BUSINESS_USER_EMAIL?.trim());
  const hasGroupTag = Boolean(resolved.AMAZON_BUSINESS_GROUP_TAG?.trim());
  const hasShippingPostalCode = Boolean(
    resolved.AMAZON_BUSINESS_SHIPPING_POSTAL_CODE?.trim(),
  );

  const searchReady =
    hasLwaClientId &&
    hasLwaClientSecret &&
    hasLwaRefreshToken &&
    hasAwsAccessKeyId &&
    hasAwsSecretAccessKey &&
    hasUserEmail;

  const orderReady = searchReady && Boolean(shippingAddress);

  return {
    enabled: searchReady,
    searchReady,
    orderReady,
    baseUrl,
    region,
    productRegion:
      resolved.AMAZON_BUSINESS_PRODUCT_REGION?.trim() ||
      DEFAULT_AMAZON_BUSINESS_PRODUCT_REGION,
    locale:
      resolved.AMAZON_BUSINESS_LOCALE?.trim() || DEFAULT_AMAZON_BUSINESS_LOCALE,
    orderMode: normalizeAmazonBusinessOrderMode(
      resolved.AMAZON_BUSINESS_ORDER_MODE,
    ),
    hasLwaClientId,
    hasLwaClientSecret,
    hasLwaRefreshToken,
    hasAwsAccessKeyId,
    hasAwsSecretAccessKey,
    hasUserEmail,
    hasGroupTag,
    hasShippingAddress: Boolean(shippingAddress),
    hasShippingPostalCode,
    timeoutMs: normalizeAmazonBusinessTimeoutMs(
      resolved.AMAZON_BUSINESS_TIMEOUT_MS,
    ),
  };
}

export function formatAmazonBusinessStatusMessage(
  status: AmazonBusinessStatus,
): string {
  const lines = [
    '*Amazon Shopping Status*',
    `- Search ready: ${status.searchReady ? 'yes' : 'no'}`,
    `- Purchase ready: ${status.orderReady ? 'yes' : 'no'}`,
    `- Mode: ${status.orderMode}`,
    `- Endpoint: ${status.baseUrl}`,
    `- AWS region: ${status.region}`,
    `- Product region / locale: ${status.productRegion} / ${status.locale}`,
    `- Buyer email configured: ${status.hasUserEmail ? 'yes' : 'no'}`,
    `- Group tag configured: ${status.hasGroupTag ? 'yes' : 'no'}`,
    `- Shipping address configured: ${status.hasShippingAddress ? 'yes' : 'no'}`,
    `- Timeout: ${status.timeoutMs}ms`,
  ];

  if (!status.searchReady) {
    lines.push(
      '- Next step: add the Amazon Business LWA + AWS credentials before Andrea can search.',
    );
  } else if (!status.orderReady) {
    lines.push(
      '- Next step: add a shipping address before Andrea can submit purchase approvals.',
    );
  } else if (status.orderMode === 'trial') {
    lines.push(
      '- Safety rail: trial mode is on, so Andrea can validate the order flow without actually firing the confetti cannon on your credit card.',
    );
  } else {
    lines.push(
      '- Live mode is enabled. Andrea will still require an approval code before submitting an order.',
    );
  }

  return lines.join('\n');
}

export function resolveAmazonBusinessConfig(
  options: AmazonBusinessStatusOptions = {},
): AmazonBusinessConfig | null {
  const resolved = resolveAmazonBusinessEnv(options);
  const status = getAmazonBusinessStatus({
    env: resolved,
    envFileValues: {},
  });

  if (!status.searchReady) return null;

  return {
    baseUrl: status.baseUrl,
    region: status.region,
    lwaClientId: resolved.AMAZON_BUSINESS_LWA_CLIENT_ID!.trim(),
    lwaClientSecret: resolved.AMAZON_BUSINESS_LWA_CLIENT_SECRET!.trim(),
    lwaRefreshToken: resolved.AMAZON_BUSINESS_LWA_REFRESH_TOKEN!.trim(),
    awsAccessKeyId: resolved.AMAZON_BUSINESS_AWS_ACCESS_KEY_ID!.trim(),
    awsSecretAccessKey: resolved.AMAZON_BUSINESS_AWS_SECRET_ACCESS_KEY!.trim(),
    awsSessionToken: resolved.AMAZON_BUSINESS_AWS_SESSION_TOKEN?.trim() || null,
    userEmail: resolved.AMAZON_BUSINESS_USER_EMAIL!.trim(),
    groupTag: resolved.AMAZON_BUSINESS_GROUP_TAG?.trim() || null,
    productRegion: status.productRegion,
    locale: status.locale,
    shippingPostalCode:
      resolved.AMAZON_BUSINESS_SHIPPING_POSTAL_CODE?.trim() || null,
    orderMode: status.orderMode,
    timeoutMs: status.timeoutMs,
    shippingAddress: resolveShippingAddress(resolved),
  };
}

function normalizeErrorBody(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function canonicalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname
    .split('/')
    .map((segment) => encodeRfc3986(segment))
    .join('/')
    .replace(/%2F/gi, '/');
}

function buildCanonicalQueryString(params: URLSearchParams): string {
  const entries = Array.from(params.entries()).map(([key, value]) => ({
    key: encodeRfc3986(key),
    value: encodeRfc3986(value),
  }));

  entries.sort((left, right) => {
    if (left.key === right.key) {
      return left.value.localeCompare(right.value);
    }
    return left.key.localeCompare(right.key);
  });

  return entries.map((entry) => `${entry.key}=${entry.value}`).join('&');
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
}

function hmacSha256Hex(key: string | Buffer, value: string): string {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function buildCredentialScope(date: string, region: string): string {
  return `${date}/${region}/${AMAZON_BUSINESS_SERVICE_NAME}/aws4_request`;
}

function buildSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
): Buffer {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, AMAZON_BUSINESS_SERVICE_NAME);
  return hmacSha256(kService, 'aws4_request');
}

export function buildAmazonBusinessOrderPayload(
  params: BuildAmazonBusinessOrderPayloadParams,
): Record<string, unknown> {
  const orderAttributes: Array<Record<string, unknown>> = [
    {
      attributeType: 'ShippingAddress',
      address: {
        addressType: 'PhysicalAddress',
        fullName: params.shippingAddress.fullName,
        phoneNumber: params.shippingAddress.phoneNumber,
        ...(params.shippingAddress.companyName
          ? { companyName: params.shippingAddress.companyName }
          : {}),
        addressLine1: params.shippingAddress.addressLine1,
        ...(params.shippingAddress.addressLine2
          ? { addressLine2: params.shippingAddress.addressLine2 }
          : {}),
        city: params.shippingAddress.city,
        stateOrRegion: params.shippingAddress.stateOrRegion,
        postalCode: params.shippingAddress.postalCode,
        countryCode: params.shippingAddress.countryCode,
      },
    },
    {
      attributeType: 'SelectedPaymentMethodReference',
      paymentMethodReference: {
        paymentMethodReferenceType: 'StoredPaymentMethod',
      },
    },
  ];

  if (params.orderMode === 'trial') {
    orderAttributes.push({ attributeType: 'TrialMode' });
  }

  return {
    externalId: params.externalId,
    lineItems: [
      {
        externalId: `${params.externalId}-line-1`,
        quantity: params.quantity,
        attributes: [
          {
            attributeType: 'SelectedProductReference',
            productReference: {
              productReferenceType: 'ProductIdentifier',
              id: params.asin,
            },
          },
          {
            attributeType: 'SelectedBuyingOptionReference',
            buyingOptionReference: {
              buyingOptionReferenceType: 'BuyingOptionIdentifier',
              id: params.offerId,
            },
          },
        ],
        expectations: [],
      },
    ],
    attributes: orderAttributes,
    expectations: [],
  };
}

function extractImageUrl(product: Record<string, unknown>): string | null {
  const candidateContainers = [
    product.includedDataTypes,
    product.included_data_types,
    product.mediaInformation,
    product.media_information,
  ];

  for (const containerValue of candidateContainers) {
    const container = asRecord(containerValue);
    if (!container) continue;

    const imageArrays = [
      container.images,
      container.IMAGES,
      container.imageItems,
      container.image_items,
    ];

    for (const imageArrayValue of imageArrays) {
      const images = asRecordArray(imageArrayValue);
      for (const image of images) {
        const candidates = [
          asRecord(image.large)?.url,
          asRecord(image.medium)?.url,
          asRecord(image.small)?.url,
          asRecord(image.thumbnail)?.url,
          image.url,
        ];
        for (const candidate of candidates) {
          const url = asString(candidate);
          if (url) return url;
        }
      }
    }
  }

  return null;
}

function parseAmazonBusinessMoney(
  price: Record<string, unknown> | null,
): AmazonBusinessMoney {
  if (!price) {
    return {
      amount: null,
      currencyCode: null,
      formattedPrice: null,
    };
  }

  const value = asRecord(price.value);
  return {
    amount: asNumber(value?.amount ?? price.amount),
    currencyCode:
      asString(value?.currencyCode) ||
      asString(value?.currency_code) ||
      asString(price.currencyCode) ||
      asString(price.currency_code),
    formattedPrice:
      asString(price.formattedPrice) || asString(price.formatted_price) || null,
  };
}

function parseAmazonBusinessOffer(
  offer: Record<string, unknown>,
): AmazonBusinessOffer | null {
  const offerId = asString(offer.offerId) || asString(offer.offer_id);
  if (!offerId) return null;

  const quantityLimits =
    asRecord(offer.quantityLimits) || asRecord(offer.quantity_limits);
  const maxQuantity =
    asNumber(quantityLimits?.maxQuantity) ||
    asNumber(quantityLimits?.max_quantity) ||
    asNumber(quantityLimits?.max);

  const merchant =
    asRecord(offer.merchant) ||
    asRecord(offer.seller) ||
    asRecord(offer.vendor);

  return {
    offerId,
    availability: asString(offer.availability),
    buyingGuidance:
      asString(offer.buyingGuidance) || asString(offer.buying_guidance) || null,
    merchantName:
      asString(merchant?.name) ||
      asString(merchant?.merchantName) ||
      asString(merchant?.merchant_name) ||
      null,
    deliveryInformation:
      asString(offer.deliveryInformation) ||
      asString(offer.delivery_information) ||
      null,
    quantityLimit: maxQuantity,
    price: parseAmazonBusinessMoney(asRecord(offer.price)),
    raw: offer,
  };
}

function extractOffersFromProduct(
  product: Record<string, unknown>,
): AmazonBusinessOffer[] {
  const containers = [
    product.includedDataTypes,
    product.included_data_types,
    product,
  ]
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));

  for (const container of containers) {
    const candidateArrays = [
      container.offers,
      container.OFFERS,
      container.offerList,
      container.offer_list,
    ];

    for (const candidate of candidateArrays) {
      const offers = asRecordArray(candidate)
        .map((entry) => parseAmazonBusinessOffer(entry))
        .filter((entry): entry is AmazonBusinessOffer => Boolean(entry));
      if (offers.length > 0) return offers;
    }
  }

  return [];
}

function parseSearchProductsResponse(
  payload: unknown,
): AmazonBusinessSearchResponse {
  const root = asRecord(payload);
  const products = asRecordArray(root?.products).map((product) => {
    const offers = extractOffersFromProduct(product);
    return {
      asin:
        asString(product.asin) ||
        asString(product.productId) ||
        asString(product.product_id) ||
        '',
      title:
        asString(product.title) ||
        asString(product.name) ||
        'Untitled Amazon product',
      productUrl: asString(product.url),
      imageUrl: extractImageUrl(product),
      features: Array.isArray(product.features)
        ? product.features
            .map((entry) => asString(entry))
            .filter((entry): entry is string => Boolean(entry))
        : [],
      offer: offers[0] || null,
      raw: product,
    } satisfies AmazonBusinessSearchItem;
  });

  return {
    totalMatches: asNumber(
      root?.matchingProductCount ?? root?.matching_product_count,
    ),
    pageCount: asNumber(root?.numberOfPages ?? root?.number_of_pages),
    items: products.filter((product) => Boolean(product.asin)),
    raw: payload,
  };
}

function parseOffersResponse(payload: unknown): AmazonBusinessOffer[] {
  const root = asRecord(payload);
  return asRecordArray(root?.offers)
    .map((offer) => parseAmazonBusinessOffer(offer))
    .filter((offer): offer is AmazonBusinessOffer => Boolean(offer));
}

export interface AmazonBusinessClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface CachedAccessToken {
  token: string;
  expiresAtMs: number;
}

export class AmazonBusinessClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private accessTokenCache: CachedAccessToken | null = null;

  constructor(
    private readonly config: AmazonBusinessConfig,
    options: AmazonBusinessClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async searchProducts(
    params: AmazonBusinessSearchProductsParams,
  ): Promise<AmazonBusinessSearchResponse> {
    const limit = Math.max(1, Math.min(10, Math.floor(params.limit || 5)));
    const quantity = Math.max(
      1,
      Math.min(999, Math.floor(params.quantity || 1)),
    );
    const searchPayload = await this.request(
      'GET',
      '/products/2020-08-26/products',
      {
        productRegion: this.config.productRegion,
        locale: this.config.locale,
        keywords: params.query,
        pageNumber: String(params.pageNumber || 0),
        pageSize: String(limit),
        ...(this.config.groupTag ? { groupTag: this.config.groupTag } : {}),
        ...(this.config.shippingPostalCode
          ? { shippingPostalCode: this.config.shippingPostalCode }
          : {}),
      },
      undefined,
      {
        'x-amz-user-email': this.config.userEmail,
      },
    );

    const parsed = parseSearchProductsResponse(searchPayload);
    const enrichedItems = await Promise.all(
      parsed.items.slice(0, limit).map(async (item) => {
        if (item.offer) return item;

        try {
          const offers = await this.getOffers({
            asin: item.asin,
            quantity,
            pageSize: 1,
          });
          return {
            ...item,
            offer: offers[0] || null,
          };
        } catch {
          return item;
        }
      }),
    );

    return {
      ...parsed,
      items: enrichedItems,
    };
  }

  async getOffers(
    params: AmazonBusinessGetOffersParams,
  ): Promise<AmazonBusinessOffer[]> {
    const payload = await this.request(
      'GET',
      `/products/2020-08-26/products/${encodeURIComponent(params.asin)}/offers`,
      {
        productRegion: this.config.productRegion,
        locale: this.config.locale,
        quantity: String(Math.max(1, Math.floor(params.quantity || 1))),
        pageNumber: '0',
        pageSize: String(
          Math.max(1, Math.min(24, Math.floor(params.pageSize || 5))),
        ),
        ...(this.config.groupTag ? { groupTag: this.config.groupTag } : {}),
        ...(this.config.shippingPostalCode
          ? { shippingPostalCode: this.config.shippingPostalCode }
          : {}),
      },
      undefined,
      {
        'x-amz-user-email': this.config.userEmail,
      },
    );

    return parseOffersResponse(payload);
  }

  async placeOrder(
    params: AmazonBusinessPlaceOrderParams,
  ): Promise<AmazonBusinessOrderResult> {
    if (!this.config.shippingAddress) {
      throw new Error(
        'Amazon Business purchasing is not configured with a shipping address.',
      );
    }

    const payload = buildAmazonBusinessOrderPayload({
      externalId: params.externalId,
      asin: params.asin,
      offerId: params.offerId,
      quantity: params.quantity,
      shippingAddress: this.config.shippingAddress,
      orderMode: this.config.orderMode,
    });

    const response = await this.request(
      'POST',
      '/ordering/2022-10-30/orders',
      undefined,
      payload,
      {},
    );
    const root = asRecord(response);

    return {
      externalId:
        asString(root?.externalId) ||
        asString(root?.external_id) ||
        params.externalId,
      submittedOrderId:
        asString(root?.submittedOrderId) ||
        asString(root?.submitted_order_id) ||
        asString(root?.orderId) ||
        asString(root?.order_id) ||
        null,
      raw: response,
    };
  }

  private async getAccessToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.accessTokenCache && this.accessTokenCache.expiresAtMs > nowMs) {
      return this.accessTokenCache.token;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.config.lwaRefreshToken,
        client_id: this.config.lwaClientId,
        client_secret: this.config.lwaClientSecret,
      });

      const response = await this.fetchImpl(AMAZON_LWA_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: body.toString(),
        signal: controller.signal,
      });

      const rawText = await response.text();
      const parsed = normalizeErrorBody(rawText);
      const record = asRecord(parsed);

      if (!response.ok) {
        const detail =
          asString(record?.error_description) ||
          asString(record?.error) ||
          (typeof parsed === 'string' ? parsed : null);
        throw new AmazonBusinessApiError(
          `Amazon Login with Amazon token exchange failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
          response.status,
          parsed,
        );
      }

      const token = asString(record?.access_token);
      if (!token) {
        throw new Error(
          'Amazon Login with Amazon token exchange returned no access token.',
        );
      }

      const expiresIn = asNumber(record?.expires_in) || 3600;
      this.accessTokenCache = {
        token,
        expiresAtMs: nowMs + Math.max(60, expiresIn - 60) * 1000,
      };
      return token;
    } catch (err) {
      if (err instanceof AmazonBusinessApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `Amazon Business token exchange timed out after ${this.config.timeoutMs}ms`,
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request(
    method: 'GET' | 'POST',
    pathname: string,
    query?: Record<string, string>,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const accessToken = await this.getAccessToken();
    const url = new URL(`${this.config.baseUrl}${pathname}`);
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') {
        queryParams.append(key, value);
      }
    }
    url.search = queryParams.toString();

    const now = this.now();
    const amzDate = formatAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const bodyText = body === undefined ? '' : JSON.stringify(body);

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-access-token': accessToken,
      'x-amz-date': amzDate,
      'user-agent': 'Andrea_NanoBot/1.0 AmazonBusinessClient',
      ...Object.fromEntries(
        Object.entries(extraHeaders).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      ),
    };

    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (this.config.awsSessionToken) {
      headers['x-amz-security-token'] = this.config.awsSessionToken;
    }

    const sortedHeaderNames = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort();
    const canonicalHeaders = sortedHeaderNames
      .map((name) => `${name}:${normalizeHeaderValue(headers[name] || '')}\n`)
      .join('');
    const signedHeaders = sortedHeaderNames.join(';');
    const canonicalRequest = [
      method,
      canonicalizePath(url.pathname),
      buildCanonicalQueryString(queryParams),
      canonicalHeaders,
      signedHeaders,
      sha256Hex(bodyText),
    ].join('\n');
    const credentialScope = buildCredentialScope(dateStamp, this.config.region);
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const authorization = [
      `AWS4-HMAC-SHA256 Credential=${this.config.awsAccessKeyId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${hmacSha256Hex(
        buildSigningKey(
          this.config.awsSecretAccessKey,
          dateStamp,
          this.config.region,
        ),
        stringToSign,
      )}`,
    ].join(', ');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          ...headers,
          Authorization: authorization,
        },
        body: body === undefined ? undefined : bodyText,
        signal: controller.signal,
      });

      const rawText = await response.text();
      const parsed = normalizeErrorBody(rawText);

      if (!response.ok) {
        const record = asRecord(parsed);
        const detail =
          asString(record?.message) ||
          asString(record?.error) ||
          asString(record?.error_description) ||
          (typeof parsed === 'string' ? parsed : null);
        throw new AmazonBusinessApiError(
          `Amazon Business API ${method} ${pathname} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
          response.status,
          parsed,
        );
      }

      return parsed;
    } catch (err) {
      if (err instanceof AmazonBusinessApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `Amazon Business API ${method} ${pathname} timed out after ${this.config.timeoutMs}ms`,
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
